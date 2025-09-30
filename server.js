const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3001;

// Directory to store recorded audio files
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Shared game state (in-memory with file persistence)
const GAME_STATE_FILE = path.join(__dirname, 'game-state.json');
let sharedGameState = [];

// Load game state from file on startup
function loadGameState() {
    try {
        if (fs.existsSync(GAME_STATE_FILE)) {
            const data = fs.readFileSync(GAME_STATE_FILE, 'utf8');
            sharedGameState = JSON.parse(data);
            console.log(`Loaded game state with ${sharedGameState.length} players`);
        }
    } catch (error) {
        console.error('Error loading game state:', error);
        sharedGameState = [];
    }
}

// Save game state to file
function saveGameState() {
    try {
        fs.writeFileSync(GAME_STATE_FILE, JSON.stringify(sharedGameState, null, 2));
    } catch (error) {
        console.error('Error saving game state:', error);
    }
}

// Load game state on startup
loadGameState();

// Session configuration
app.use(session({
    secret: 'audio-game-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Serve uploaded files
app.use('/uploads', express.static(UPLOAD_DIR));

// Helper functions
function getCurrentPlayerStatus(gameState) {
    if (gameState.length === 0) {
        return { isNewPlayer: true, playerNumber: 1, needsSecondFile: false, canRecordFirst: true, canRecordSecond: false, isRecording: false };
    }
    
    const lastPlayer = gameState[gameState.length - 1];
    
    // If last player has both files, next player can start
    if (lastPlayer.length >= 4 && lastPlayer[0] && lastPlayer[1]) {
        return { isNewPlayer: true, playerNumber: gameState.length + 1, needsSecondFile: false, canRecordFirst: true, canRecordSecond: false, isRecording: false };
    }
    
    // If last player only has first file, they need to record second file
    if (lastPlayer.length >= 4 && lastPlayer[0] && !lastPlayer[1]) {
        // Check if recording has timed out (2 minutes)
        const recordingStartTime = lastPlayer[3]; // Store timestamp when first recording was made
        const now = Date.now();
        const twoMinutes = 2 * 60 * 1000;
        
        if (recordingStartTime && (now - recordingStartTime) > twoMinutes) {
            // Timeout - remove the first recording and allow new player
            lastPlayer[0] = null;
            lastPlayer[3] = null; // Clear timestamp
            return { isNewPlayer: true, playerNumber: gameState.length, needsSecondFile: false, canRecordFirst: true, canRecordSecond: false, isRecording: false };
        } else {
            // Current player can record second file
            return { isNewPlayer: false, playerNumber: gameState.length, needsSecondFile: true, canRecordFirst: false, canRecordSecond: true, isRecording: false };
        }
    }
    
    // If last player has no files yet, they can record first file
    if (!lastPlayer[0]) {
        return { isNewPlayer: false, playerNumber: gameState.length, needsSecondFile: false, canRecordFirst: true, canRecordSecond: false, isRecording: false };
    }
    
    return { isNewPlayer: false, playerNumber: gameState.length, needsSecondFile: false, canRecordFirst: false, canRecordSecond: false, isRecording: false };
}

function getVisibleAudioFiles(gameState) {
    const visibleFiles = [];
    
    for (let i = 0; i < gameState.length; i++) {
        const player = gameState[i];
        const playerName = player[2] || `Player ${i + 1}`;
        const playerFiles = { 
            playerNumber: i + 1, 
            playerName: playerName,
            firstFile: null, 
            secondFile: null 
        };
        
        // First file is always visible if it exists
        if (player[0]) {
            playerFiles.firstFile = player[0];
        }
        
        // Second file is visible only if next player has recorded their first file
        if (player[1]) {
            if (i + 1 < gameState.length && gameState[i + 1][0]) {
                playerFiles.secondFile = player[1];
            }
        }
        
        visibleFiles.push(playerFiles);
    }
    
    return visibleFiles;
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Hidden reset route
app.get('/reset', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/game-state', (req, res) => {
    const playerStatus = getCurrentPlayerStatus(sharedGameState);
    const visibleFiles = getVisibleAudioFiles(sharedGameState);
    
    res.json({
        gameState: sharedGameState,
        playerStatus: playerStatus,
        visibleFiles: visibleFiles
    });
});

app.post('/api/record-first-audio', (req, res) => {
    try {
        const { audioData, mimeType, playerName } = req.body;
        
        if (!audioData) {
            return res.status(400).json({ error: 'No audio data received' });
        }
        
        const playerStatus = getCurrentPlayerStatus(sharedGameState);
        
        if (!playerStatus.canRecordFirst) {
            return res.status(400).json({ error: 'Not ready to record first audio' });
        }
        
        // Generate filename for recorded audio
        const playerIdx = sharedGameState.length;
        const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = mimeType.includes('webm') ? '.webm' : '.wav';
        const filename = `player${playerIdx}_file1_${uniqueId}${extension}`;
        const filePath = path.join(UPLOAD_DIR, filename);
        
        // Save audio data to file
        const audioBuffer = Buffer.from(audioData, 'base64');
        fs.writeFileSync(filePath, audioBuffer);
        
        // Add new player with first file, name, and timestamp
        sharedGameState.push([filename, null, playerName || `Spieler ${playerIdx + 1}`, Date.now()]);
        
        // Save game state to file
        saveGameState();
        
        res.json({ 
            success: true, 
            message: 'Erste Aufnahme gespeichert! Jetzt nimm deine zweite Aufnahme auf.',
            filename: filename
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/record-second-audio', (req, res) => {
    try {
        const { audioData, mimeType, playerName } = req.body;
        
        if (!audioData) {
            return res.status(400).json({ error: 'No audio data received' });
        }
        
        const playerStatus = getCurrentPlayerStatus(sharedGameState);
        
        if (!playerStatus.canRecordSecond) {
            return res.status(400).json({ error: 'Not ready to record second audio' });
        }
        
        // Generate filename for recorded audio
        const playerIdx = sharedGameState.length - 1;
        const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = mimeType.includes('webm') ? '.webm' : '.wav';
        const filename = `player${playerIdx}_file2_${uniqueId}${extension}`;
        const filePath = path.join(UPLOAD_DIR, filename);
        
        // Save audio data to file
        const audioBuffer = Buffer.from(audioData, 'base64');
        fs.writeFileSync(filePath, audioBuffer);
        
        // Update current player's second file
        sharedGameState[sharedGameState.length - 1][1] = filename;
        
        // Update player name if provided
        if (playerName) {
            sharedGameState[sharedGameState.length - 1][2] = playerName;
        }
        
        // Clear the timestamp since recording is complete
        sharedGameState[sharedGameState.length - 1][3] = null;
        
        // Save game state to file
        saveGameState();
        
        res.json({ 
            success: true, 
            message: 'Zweite Aufnahme gespeichert! Warte auf den nächsten Spieler.',
            filename: filename
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Reset game state (for testing purposes)
app.post('/api/reset-game', (req, res) => {
    sharedGameState = [];
    saveGameState();
    res.json({ success: true, message: 'Spiel zurückgesetzt!' });
});

// Error handling middleware
app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
