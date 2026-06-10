const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

const rooms = {}; 
const users = {};
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

// Növbəti oyunçunun indeksini hesablayan funksiya (Yönü nəzərə alır)
function getNextTurn(room) {
    let next = room.currentTurn + room.direction;
    if (next < 0) next = room.players.length - 1;
    if (next >= room.players.length) next = 0;
    return next;
}

// Dekdən oyunçuya kart verən funksiya
function drawCardsForPlayer(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) {
            room.deck = createUnoDeck();
        }
        player.cards.push(room.deck.pop());
    }
    io.to(player.id).emit('your-cards', player.cards);
}

io.on('connection', (socket) => {
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
            direction: 1, // 1 = Saat əqrəbi yönü, -1 = Əks yön
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
            drawCardsForPlayer(room, player, 7);
        });

        let firstCard = room.deck.pop();
        while(firstCard.color === 'black' || firstCard.type === '+2' || firstCard.type === '🚫' || firstCard.type === '⇄') {
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

    // DEKDƏN KART ÇƏKMƏK
    socket.on('draw-card', (roomId) => {
        const room = rooms[roomId];
        if (!room || room.status !== 'playing') return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return socket.emit('error-msg', 'Sizin növbəniz deyil!');

        // 1 ədəd kart çəkir
        drawCardsForPlayer(room, player, 1);

        // Növbəni növbəti oyunçuya ötürürük
        room.currentTurn = getNextTurn(room);

        io.to(roomId).emit('game-updated', {
            topCard: room.discardPile[room.discardPile.length - 1],
            currentTurnId: room.players[room.currentTurn].id,
            players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
        });
    });

    // KART ATILMASI VƏ ƏSL UNO QAYDALARI
    socket.on('play-card', ({ roomId, card, chosenColor }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return socket.emit('error-msg', 'Sizin növbəniz deyil!');

        const topCard = room.discardPile[room.discardPile.length - 1];

        // Kart atma şərti (Rəng eyni, tip eyni və ya Qara kartdırsa)
        if (card.color === topCard.color || card.type === topCard.type || card.color === 'black') {
            
            // Kartı oyunçunun əlindən silirik
            player.cards = player.cards.filter(c => !(c.color === card.color && c.type === card.type));
            
            // Qara kart atılıbsa rəngi dəyişirik
            if (card.color === 'black' && chosenColor) {
                card.color = chosenColor; 
            }

            // Kartı yerə atırıq
            room.discardPile.push(card);

            // Qalibiyyət yoxlanışı
            if (player.cards.length === 0) {
                io.to(roomId).emit('game-over', { winner: player.username });
                room.status = 'waiting';
                return;
            }

            // NÖVBƏTİ OYUNÇUNUN TƏYİN EDİLMƏSİ VƏ KART QAYDALARI
            let nextPlayerIndex = getNextTurn(room);
            let nextPlayer = room.players[nextPlayerIndex];

            if (card.type === '🚫') {
                // Pas kartı: Növbəti oyunçunu atlayır, ondan sonrakına keçir
                io.to(roomId).emit('special-card-log', `${player.username} PAS atdı! ${nextPlayer.username} bu turu oynamır.`);
                room.currentTurn = getNextTurn({ ...room, currentTurn: nextPlayerIndex });
            } 
            else if (card.type === '⇄') {
                // Yön dəyişmə kartı
                room.direction *= -1;
                io.to(roomId).emit('special-card-log', `Oyunun yönü dəyişdi! ⇄`);
                room.currentTurn = getNextTurn(room); // Yeni yönə görə növbəti oyunçu
            } 
            else if (card.type === '+2') {
                // +2 Kartı: Növbəti oyunçuya 2 kart verir və növbəsini əlindən alır
                drawCardsForPlayer(room, nextPlayer, 2);
                io.to(roomId).emit('special-card-log', `${player.username} +2 atdı! ${nextPlayer.username} 2 kart çəkdi və turu itirdi.`);
                room.currentTurn = getNextTurn({ ...room, currentTurn: nextPlayerIndex });
            } 
            else if (card.type === '🔥+4') {
                // 🔥+4 Kartı: Növbəti oyunçuya 4 kart verir və növbəsini əlindən alır
                drawCardsForPlayer(room, nextPlayer, 4);
                io.to(roomId).emit('special-card-log', `${player.username} 🔥+4 atdı! ${nextPlayer.username} 4 kart çəkdi və turu itirdi.`);
                room.currentTurn = getNextTurn({ ...room, currentTurn: nextPlayerIndex });
            } 
            else {
                // Normal rəqəm kartı atılıbsa, növbə sadəcə növbəti oyunçuya keçir
                room.currentTurn = nextPlayerIndex;
            }

            // Hamıya oyunun yeniləndiyini xəbər veririk
            io.to(roomId).emit('game-updated', {
                topCard: card,
                currentTurnId: room.players[room.currentTurn].id,
                players: room.players.map(p => ({ id: p.id, username: p.username, cardCount: p.cards.length }))
            });

            // Kartı atan oyunçuya öz yeni əlini göndəririk
            socket.emit('your-cards', player.cards);

        } else {
            socket.emit('error-msg', 'Bu kartı ata bilməzsiniz! Rəng və ya simvol uyğun gəlmir.');
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
