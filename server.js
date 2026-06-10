const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

const rooms = {}; 
const colors = ['red', 'blue', 'green', 'yellow'];
// Əsl UNO simvolları: 🚫 (Skip), ⇄ (Reverse), +2 (Draw Two), 🌈 (Wild), 🔥+4 (Wild Draw Four)
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

io.on('connection', (socket) => {
    console.log(`İstifadəçi qoşuldu: ${socket.id}`);
    socket.emit('update-room-list', Object.values(rooms).map(r => ({ id: r.id, title: r.title, count: r.players.length })));

    socket.on('create-room', ({ username, roomName }) => {
        const roomId = 'room-' + Math.floor(1000 + Math.random() * 9000);
        rooms[roomId] = {
            id: roomId,
            title: roomName || `${username} otağı`,
            players: [],
            deck: createUnoDeck(),
            discardPile: [],
            currentTurn: 0,
            status: 'waiting'
        };
        joinRoomLogic(socket, roomId, username);
    });

    socket.on('join-room', ({ roomId, username }) => {
        if (!rooms[roomId]) return socket.emit('error-msg', 'Otaq tapılmadı!');
        if (rooms[roomId].players.length >= 4) return socket.emit('error-msg', 'Otaq doludur!');
        if (rooms[roomId].status === 'playing') return socket.emit('error-msg', 'Oyun artıq başlayıb!');
        joinRoomLogic(socket, roomId, username);
    });

    function joinRoomLogic(socket, roomId, username) {
        socket.join(roomId);
        rooms[roomId].players.push({ id: socket.id, username: username, cards: [] });
        const room = rooms[roomId];
        io.to(roomId).emit('room-joined', {
            roomId: room.id,
            title: room.title,
            players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
        });
        updateGlobalRoomList();
    }

    socket.on('send-message', ({ roomId, message, username }) => {
        if (!rooms[roomId]) return;
        io.to(roomId).emit('receive-message', { senderId: socket.id, username: username, text: message });
    });

    socket.on('start-game', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status === 'playing') return;
        room.status = 'playing';
        room.players.forEach(player => {
            player.cards = room.deck.splice(0, 7);
            io.to(player.id).emit('your-cards', player.cards);
        });
        let firstCard = room.deck.pop();
        while(firstCard.color === 'black') {
            room.deck.unshift(firstCard);
            firstCard = room.deck.pop();
        }
        room.discardPile.push(firstCard);
        io.to(roomId).emit('game-started', {
            topCard: firstCard,
            currentTurnId: room.players[room.currentTurn].id,
            players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
        });
    });

    socket.on('draw-card', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;
        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return socket.emit('error-msg', 'Sizin növbəniz deyil!');
        if (room.deck.length === 0) room.deck = createUnoDeck();
        const newCard = room.deck.pop();
        player.cards.push(newCard);
        room.currentTurn = (room.currentTurn + 1) % room.players.length;
        io.to(roomId).emit('game-updated', {
            topCard: room.discardPile[room.discardPile.length - 1],
            currentTurnId: room.players[room.currentTurn].id,
            players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
        });
        socket.emit('your-cards', player.cards);
    });

    socket.on('play-card', ({ roomId, card, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return socket.emit('error-msg', 'Sizin növbəniz deyil!');
        const topCard = room.discardPile[room.discardPile.length - 1];

        if (card.color === topCard.color || card.type === topCard.type || card.color === 'black') {
            player.cards = player.cards.filter(c => !(c.color === card.color && c.type === card.type));
            if (card.color === 'black' && chosenColor) card.color = chosenColor;
            room.discardPile.push(card);
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(roomId).emit('game-updated', {
                topCard: card,
                currentTurnId: room.players[room.currentTurn].id,
                players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
            });
            socket.emit('your-cards', player.cards);
        } else {
            socket.emit('error-msg', 'Bu kartı ata bilməzsiniz!');
        }
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            let room = rooms[roomId];
            const pIndex = room.players.findIndex(p => p.id === socket.id);
            if (pIndex !== -1) {
                room.players.splice(pIndex, 1);
                if (room.players.length === 0) { delete rooms[roomId]; } 
                else {
                    io.to(roomId).emit('room-joined', {
                        roomId: room.id,
                        title: room.title,
                        players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
                    });
                }
                updateGlobalRoomList();
                break;
            }
        }
    });
});

function updateGlobalRoomList() {
    io.emit('update-room-list', Object.values(rooms).map(r => ({ id: r.id, title: r.title, count: r.players.length })));
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`UNO Serveri ${PORT} portunda aktivdir 🚀`); });
