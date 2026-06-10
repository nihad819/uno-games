const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

const rooms = {};
const users = {}; // 👈 NEW SYSTEM

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

io.on('connection', (socket) => {

    // 👇 USER CREATE
    users[socket.id] = {
        xp: 0,
        level: 1,
        wins: 0,
        losses: 0,
        lastBonus: null
    };

    socket.emit('update-room-list', Object.values(rooms).map(r => ({
        id: r.id,
        title: r.title,
        count: r.players.length
    })));

    // CREATE ROOM
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

    // JOIN ROOM
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

        const room = rooms[roomId];

        io.to(roomId).emit('room-joined', {
            roomId: room.id,
            title: room.title,
            players: room.players.map(p => ({
                id: p.id,
                username: p.username,
                cardCount: p.cards.length
            }))
        });

        io.emit('update-room-list', Object.values(rooms).map(r => ({
            id: r.id,
            title: r.title,
            count: r.players.length
        })));
    }

    socket.on('send-message', ({ roomId, message, username }) => {
        io.to(roomId).emit('receive-message', {
            senderId: socket.id,
            username,
            text: message
        });
    });

    // START GAME
    socket.on('start-game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status === 'playing') return;

        room.status = 'playing';

        room.players.forEach(p => drawCardsForPlayer(room, p, 7));

        let firstCard = room.deck.pop();

        while (['🌈', '🔥+4', '+2', '🚫', '⇄'].includes(firstCard.type)) {
            room.deck.unshift(firstCard);
            firstCard = room.deck.pop();
        }

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

    // DRAW CARD
    socket.on('draw-card', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        drawCardsForPlayer(room, player, 1);
        room.currentTurn = getNextTurn(room);

        io.to(roomId).emit('game-updated', {
            topCard: room.discardPile.at(-1),
            currentTurnId: room.players[room.currentTurn].id,
            players: room.players.map(p => ({
                id: p.id,
                username: p.username,
                cardCount: p.cards.length
            }))
        });
    });

    // PLAY CARD
    socket.on('play-card', ({ roomId, card, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        const topCard = room.discardPile.at(-1);

        if (card.color === topCard.color || card.type === topCard.type || card.color === 'black') {

            player.cards = player.cards.filter(c =>
                !(c.color === card.color && c.type === card.type)
            );

            if (card.color === 'black' && chosenColor) {
                card.color = chosenColor;
            }

            room.discardPile.push(card);

            // WIN
            if (player.cards.length === 0) {

                users[player.id].wins++;
                users[player.id].xp += 50;
                users[player.id].level = Math.floor(users[player.id].xp / 100) + 1;

                room.players.forEach(p => {
                    if (p.id !== player.id) {
                        if (users[p.id]) users[p.id].losses++;
                    }
                });

                io.to(roomId).emit('game-over', {
                    winner: player.username,
                    stats: users[player.id]
                });

                room.status = 'waiting';
                return;
            }

            let next = getNextTurn(room);
            room.currentTurn = next;

            io.to(roomId).emit('game-updated', {
                topCard: card,
                currentTurnId: room.players[next].id,
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

    // LEADERBOARD
    socket.on('get-leaderboard', () => {
        const board = Object.entries(users)
            .map(([id, u]) => ({
                id,
                xp: u.xp,
                level: u.level,
                wins: u.wins
            }))
            .sort((a, b) => b.wins - a.wins)
            .slice(0, 10);

        socket.emit('leaderboard-data', board);
    });

    // DAILY BONUS
    socket.on('daily-bonus', () => {
        let u = users[socket.id];
        let today = new Date().toDateString();

        if (u.lastBonus === today) {
            return socket.emit('error-msg', 'Bugünkü bonus alınıb!');
        }

        u.lastBonus = today;
        u.xp += 20;
        u.level = Math.floor(u.xp / 100) + 1;

        socket.emit('bonus-received', u);
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        delete users[socket.id];

        for (let roomId in rooms) {
            let room = rooms[roomId];

            room.players = room.players.filter(p => p.id !== socket.id);

            if (room.players.length === 0) {
                delete rooms[roomId];
            }
        }

        io.emit('update-room-list', Object.values(rooms).map(r => ({
            id: r.id,
            title: r.title,
            count: r.players.length
        })));
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("Server işləyir 🚀"));