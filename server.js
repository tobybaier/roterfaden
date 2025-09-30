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
function initializeGameState(req) {
    if (!req.session.gameState) {
        req.session.gameState = [];
    }
    return req.session.gameState;
}

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

app.get('/api/game-state', (req, res) => {
    const gameState = initializeGameState(req);
    const playerStatus = getCurrentPlayerStatus(gameState);
    const visibleFiles = getVisibleAudioFiles(gameState);
    
    res.json({
        gameState: gameState,
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
        
        const gameState = initializeGameState(req);
        const playerStatus = getCurrentPlayerStatus(gameState);
        
        if (!playerStatus.isNewPlayer) {
            return res.status(400).json({ error: 'Not ready for new player' });
        }
        
        // Generate filename for recorded audio
        const playerIdx = gameState.length;
        const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = mimeType.includes('webm') ? '.webm' : '.wav';
        const filename = `player${playerIdx}_file1_${uniqueId}${extension}`;
        const filePath = path.join(UPLOAD_DIR, filename);
        
        // Save audio data to file
        const audioBuffer = Buffer.from(audioData, 'base64');
        fs.writeFileSync(filePath, audioBuffer);
        
        // Add new player with first file, name, and timestamp
        gameState.push([filename, null, playerName || `Player ${playerIdx + 1}`, Date.now()]);
        
        res.json({ 
            success: true, 
            message: 'First audio recorded! Now record your second audio.',
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
        
        const gameState = initializeGameState(req);
        const playerStatus = getCurrentPlayerStatus(gameState);
        
        if (!playerStatus.needsSecondFile) {
            return res.status(400).json({ error: 'Not ready for second file' });
        }
        
        // Generate filename for recorded audio
        const playerIdx = gameState.length - 1;
        const uniqueId = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = mimeType.includes('webm') ? '.webm' : '.wav';
        const filename = `player${playerIdx}_file2_${uniqueId}${extension}`;
        const filePath = path.join(UPLOAD_DIR, filename);
        
        // Save audio data to file
        const audioBuffer = Buffer.from(audioData, 'base64');
        fs.writeFileSync(filePath, audioBuffer);
        
        // Update current player's second file
        gameState[gameState.length - 1][1] = filename;
        
        // Update player name if provided
        if (playerName) {
            gameState[gameState.length - 1][2] = playerName;
        }
        
        // Clear the timestamp since recording is complete
        gameState[gameState.length - 1][3] = null;
        
        res.json({ 
            success: true, 
            message: 'Second audio recorded! Wait for the next player to join.',
            filename: filename
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
    res.status(500).json({ error: error.message });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
