const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, { cors: { origin: "*" } });
const path = require("path");

const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const rooms = {};

const colors = ["red", "blue", "green", "yellow"];
const types = ["0","1","2","3","4","5","6","7","8","9","+2","🚫","⇄","🌈","🔥+4"];

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------- DECK ----------------
function createDeck() {
    let deck = [];
    colors.forEach(c => {
        types.forEach(t => {
            if (t !== "🌈" && t !== "🔥+4") {
                deck.push({ color: c, type: t });
                if (t !== "0") deck.push({ color: c, type: t });
            }
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: "black", type: "🌈" });
        deck.push({ color: "black", type: "🔥+4" });
    }

    return deck.sort(() => Math.random() - 0.5);
}

function nextTurn(room) {
    let n = room.currentTurn + room.direction;
    if (n < 0) n = room.players.length - 1;
    if (n >= room.players.length) n = 0;
    return n;
}

function draw(room, player, count) {
    for (let i = 0; i < count; i++) {
        if (room.deck.length === 0) room.deck = createDeck();
        player.cards.push(room.deck.pop());
    }
    io.to(player.id).emit("your-cards", player.cards);
}

// ---------------- FIREBASE ----------------
async function getUser(id) {
    const doc = await db.collection("users").doc(id).get();
    return doc.exists ? doc.data() : null;
}

async function saveUser(id, data) {
    await db.collection("users").doc(id).set(data, { merge: true });
}

// ---------------- RANK ----------------
function getRank(xp) {
    if (xp < 100) return "🥉 Bronze";
    if (xp < 300) return "🥈 Silver";
    if (xp < 600) return "🥇 Gold";
    if (xp < 1000) return "💎 Diamond";
    return "👑 Legend";
}

// ---------------- LEADERBOARD ----------------
async function leaderboard() {
    const snap = await db.collection("users").get();
    let arr = [];
    snap.forEach(d => arr.push(d.data()));
    return arr.sort((a,b) => (b.xp||0)-(a.xp||0));
}

// ---------------- SOCKET ----------------
io.on("connection", (socket) => {

    socket.on("create-room", ({ username }) => {
        const id = "room-" + Math.floor(Math.random()*9999);

        rooms[id] = {
            id,
            title: username + " room",
            players: [],
            deck: createDeck(),
            discard: [],
            currentTurn: 0,
            direction: 1,
            status: "waiting"
        };

        join(socket, id, username);
    });

    socket.on("join-room", ({ roomId, username }) => {
        if (!rooms[roomId]) return;
        join(socket, roomId, username);
    });

    function join(socket, roomId, username) {
        socket.join(roomId);

        rooms[roomId].players.push({
            id: socket.id,
            username,
            cards: []
        });

        io.to(roomId).emit("room-joined", {
            roomId,
            players: rooms[roomId].players.map(p => ({
                id: p.id,
                username: p.username,
                cardCount: p.cards.length
            }))
        });
    }

    // ---------------- START GAME ----------------
    socket.on("start-game", (roomId) => {
        const room = rooms[roomId];
        if (!room) return;

        room.status = "playing";

        room.players.forEach(p => draw(room, p, 7));

        const first = room.deck.pop();
        room.discard.push(first);

        io.to(roomId).emit("game-started", {
            topCard: first,
            currentTurnId: room.players[0].id
        });
    });

    // ---------------- PLAY CARD ----------------
    socket.on("play-card", async ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players[room.currentTurn];
        if (player.id !== socket.id) return;

        const top = room.discard.at(-1);

        if (card.color === top.color || card.type === top.type || card.color === "black") {

            player.cards = player.cards.filter(c =>
                !(c.color === card.color && c.type === card.type)
            );

            room.discard.push(card);

            // ---------------- WIN ----------------
            if (player.cards.length === 0) {

                let user = await getUser(player.id) || {
                    xp: 0,
                    wins: 0,
                    losses: 0,
                    level: 1,
                    rank: "🥉 Bronze",
                    coins: 0
                };

                user.wins++;
                user.xp += 50;
                user.level = Math.floor(user.xp / 100) + 1;
                user.rank = getRank(user.xp);
                user.coins += 10;

                await saveUser(player.id, user);

                for (let p of room.players) {
                    if (p.id !== player.id) {
                        let u = await getUser(p.id) || {
                            xp: 0,
                            wins: 0,
                            losses: 0,
                            level: 1,
                            rank: "🥉 Bronze",
                            coins: 0
                        };

                        u.losses++;
                        await saveUser(p.id, u);
                    }
                }

                io.to(roomId).emit("game-over", {
                    winner: player.username,
                    stats: user
                });

                room.status = "waiting";
                return;
            }

            room.currentTurn = nextTurn(room);

            io.to(roomId).emit("game-updated", {
                topCard: card,
                currentTurnId: room.players[room.currentTurn].id
            });

            socket.emit("your-cards", player.cards);

        }
    });

    // ---------------- DRAW CARD ----------------
    socket.on("draw-card", (roomId) => {
        const room = rooms[roomId];
        const player = room.players[room.currentTurn];

        if (player.id !== socket.id) return;

        draw(room, player, 1);

        room.currentTurn = nextTurn(room);

        io.to(roomId).emit("game-updated", {
            currentTurnId: room.players[room.currentTurn].id
        });
    });

    // ---------------- LEADERBOARD ----------------
    socket.on("get-leaderboard", async () => {
        socket.emit("leaderboard-data", (await leaderboard()).slice(0, 10));
    });

    // ---------------- PROFILE ----------------
    socket.on("get-profile", async () => {
        let user = await getUser(socket.id);

        if (!user) {
            user = { xp: 0, wins: 0, losses: 0, level: 1, rank: "🥉 Bronze", coins: 0 };
        }

        socket.emit("profile-data", user);
    });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log("UNO FULL SERVER RUN 🚀"));