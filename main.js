import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';

// Global state
let game, ui, replayRecorder, canvasUI, audioManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;
let currentScore = 0;
let isScoreSubmitted = false;
let replayBlobPromise = null;
let replayUrlPromise = null;

const room = new WebsimSocket();

function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: (score) => {
            setTimeout(() => {
                replayRecorder?.stop();
            }, 3000);
            currentScore = score;
            isScoreSubmitted = false;
            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');
            
            // Make replay blob available for viewing, then try to submit score
            if (replayRecorder) {
                replayBlobPromise = replayRecorder.getReplayBlob();
                replayBlobPromise.then(blob => {
                    ui.setReplayButtonState(false, 'Watch Replay');
                    if (!isScoreSubmitted) {
                        autoSubmitScore(blob);
                    }
                }).catch(error => {
                    console.error("Error getting replay blob:", error);
                    ui.setReplayButtonState(false, 'Replay Failed');
                });
            } else {
                autoSubmitScore(null);
            }
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    // Subscribe to all scores for the public leaderboard
    room.collection('score_v1').subscribe(scores => {
        const sortedScores = scores.sort((a, b) => b.score - a.score);
        ui.updateLeaderboard(sortedScores, (replayUrl) => {
            ui.showReplayViewer(replayUrl);
        });
    });

    renderer.setAnimationLoop(animate);
    startGame();
}

function startGame() {
    game.start();
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
    replayBlobPromise = null;
    replayUrlPromise = null;
    
    replayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
}

function restart() {
    if (replayRecorder && replayRecorder.isRecording) {
        replayRecorder.stop();
    }
    game.restart();
    startGame();
}

async function autoSubmitScore(replayBlob) {
    if (isScoreSubmitted) return;
    isScoreSubmitted = true; // Prevent multiple submissions

    try {
        const currentUser = await window.websim.getCurrentUser();
        if (!currentUser) {
            ui.setSubmitStatus('Could not get user info.', '#f44336');
            isScoreSubmitted = false;
            return;
        }

        // Get the user's current scores.
        const allScores = room.collection('score_v1').getList();
        const userScores = allScores.filter(score => score.username === currentUser.username);
        userScores.sort((a, b) => a.score - b.score);

        let shouldSubmit = false;
        let lowestScoreRecord = null;

        if (userScores.length < 3) {
            shouldSubmit = true;
        } else {
            lowestScoreRecord = userScores[0];
            if (currentScore > lowestScoreRecord.score) {
                shouldSubmit = true;
            }
        }

        if (!shouldSubmit) {
            ui.setSubmitStatus('Score too low for leaderboard.', '#f44336');
            return;
        }
        
        let replayUrl = null;
        if (replayBlob) {
            ui.setSubmitStatus('Uploading replay...', '#ff9800');
            try {
                replayUrl = await window.websim.upload(replayBlob);
            } catch (uploadError) {
                console.error("Replay upload failed:", uploadError);
                ui.setSubmitStatus('Replay upload failed, submitting score only.', '#ff9800');
            }
        } else {
            ui.setSubmitStatus('Submitting score...', '#ff9800');
        }


        if (lowestScoreRecord && userScores.length >= 3) {
            // Update the lowest score
            await room.collection('score_v1').update(lowestScoreRecord.id, { score: currentScore, replayUrl });
            ui.setSubmitStatus('High score updated!', '#4CAF50');
        } else {
            // Create a new score record
            await room.collection('score_v1').create({
                score: currentScore,
                replayUrl,
            });
            ui.setSubmitStatus('Score submitted!', '#4CAF50');
        }

    } catch (error) {
        console.error("Failed to auto-submit score:", error);
        ui.setSubmitStatus('Error submitting score.', '#f44336');
        isScoreSubmitted = false; // Allow retry if submission fails
    }
}

async function viewReplay() {
    if (!replayBlobPromise) {
        // Fallback for cases where submission might have failed before blob was ready
        if (replayRecorder) {
            replayBlobPromise = replayRecorder.getReplayBlob();
        } else {
            alert("Replay not available.");
            return;
        }
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        const blob = await replayBlobPromise;
        if (blob) {
            ui.showReplayViewer(blob);
        }
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay');
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in autoSubmitScore.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(currentScore);
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();