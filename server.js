const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const rooms = {};

const colors = ['red', 'blue', 'green', 'yellow'];
const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+2', '🚫', '⇄', '🌈', '🔥+4'];

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

function createUnoDeck() {
    let deck = [];
    colors.forEach(color => {
        types.forEach(type => {
            if (type !== '🌈' && type !== '🔥+4') {
                deck.push({ color, type });
                if (type !== '0') deck.push({ color, type });
            }
        });
    });
    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', type: '🌈' });
        deck.push({ color: 'black', type: '🔥+4' });
    }
    return deck.sort(() => Math.random() - 0.5);
}

function getNextTurn(room) {
    let next = room.currentTurn + room.direction;
    if (next < 0) next = room.players.length - 1;
    if (next >= room.players.length) next = 0;
    return next;
}

function drawCardsForPlayer(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) room.deck = createUnoDeck();
        player.cards.push(room.deck.pop());
    }
    io.to(player.id).emit('your-cards', player.cards);
}

// FIREBASE USER FUNCTIONS
async function getUser(id) {
    const doc = await db.collection("users").doc(id).get();
    return doc.exists ? doc.data() : null;
}

async function saveUser(id, data) {
    await db.collection("users").doc(id).set(data, { merge: true });
}

io.on('connection', (socket) => {

    socket.emit('update-room-list', Object.values(rooms).map(r => ({
        id: r.id,
        title: r.title,
        count: r.players.length
    })));

    socket.on('create-room', ({ username, roomName }) => {
        const roomId = 'room-' + Math.floor(1000 + Math.random() * 9000);

        rooms[roomId] = {
            id: roomId,
            title: roomName || `${username} otağı`,
            players: [],
            deck: createUnoDeck(),
            discardPile: [],
            currentTurn: 0,
            direction: 1,
            status: 'waiting'
        };

        joinRoomLogic(socket, roomId, username);
    });

    socket.on('join-room', ({ roomId, username }) => {
        if (!rooms[roomId]) return socket.emit('error-msg', 'Otaq tapılmadı!');
        if (rooms[roomId].players.length >= 4) return socket.emit('error-msg', 'Otaq doludur!');
        if (rooms[roomId].status === 'playing') return socket.emit('error-msg', 'Oyun başladı!');

        joinRoomLogic(socket, roomId, username);
    });

    function joinRoomLogic(socket, roomId, username) {
        socket.join(roomId);

        rooms[roomId].players.push({
            id: socket.id,
            username,
            cards: []
        });

        io.emit('update-room-list', Object.values(rooms).map(r => ({
            id: r.id,
            title: r.title,
            count: r.players.length
        })));

        io.to(roomId).emit('room-joined', {
            roomId,
            title: rooms[roomId].title,
            players: rooms[roomId].players.map(p => ({
                id: p.id,
                username: p.username,
                cardCount: p.cards.length
            }))
        });
    }

    socket.on('start-game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status === 'playing') return;

        room.status = 'playing';

        room.players.forEach(p => drawCardsForPlayer(room, p, 7));

        let firstCard = room.deck.pop();
        room.discardPile.push(firstCard);

        io.to(roomId).emit('game-started', {
            topCard: firstCard,
            currentTurnId: room.players[0].id,
            players: room.players.map(p => ({
                id: p.id,
                username: p.username,
                cardCount: p.cards.length
            }))
        });
    });

    socket.on('play-card', async ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        const top = room.discardPile.at(-1);

        if (card.color === top.color || card.type === top.type || card.color === 'black') {

            player.cards = player.cards.filter(c =>
                !(c.color === card.color && c.type === card.type)
            );

            room.discardPile.push(card);

            // WIN
            if (player.cards.length === 0) {

                let user = await getUser(player.id) || {
                    xp: 0,
                    wins: 0,
                    losses: 0,
                    level: 1
                };

                user.wins += 1;
                user.xp += 50;
                user.level = Math.floor(user.xp / 100) + 1;

                await saveUser(player.id, user);

                for (let p of room.players) {
                    if (p.id !== player.id) {
                        let u = await getUser(p.id) || {
                            xp: 0,
                            wins: 0,
                            losses: 0,
                            level: 1
                        };

                        u.losses += 1;
                        await saveUser(p.id, u);
                    }
                }

                io.to(roomId).emit('game-over', {
                    winner: player.username,
                    stats: user
                });

                room.status = 'waiting';
                return;
            }

            room.currentTurn = getNextTurn(room);

            io.to(roomId).emit('game-updated', {
                topCard: card,
                currentTurnId: room.players[room.currentTurn].id,
                players: room.players.map(p => ({
                    id: p.id,
                    username: p.username,
                    cardCount: p.cards.length
                }))
            });

            socket.emit('your-cards', player.cards);

        } else {
            socket.emit('error-msg', 'Yanlış kart!');
        }
    });

    socket.on('disconnect', () => {
        for (let id in rooms) {
            rooms[id].players = rooms[id].players.filter(p => p.id !== socket.id);
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("UNO Server işləyir 🚀"));