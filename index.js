const express = require("express");
const app = express();
const http = require("http");
const WebSocket = require("ws");
const { Pool } = require('pg');
const Bcrypt = require("react-native-bcrypt");  //Encryption and comparison of passwords
const nodemailer = require('nodemailer');       //Sending email for changing passwords
const generator = require('generate-password'); //Assigning password when requested

//Credentials for sending email.
const transporter = nodemailer.createTransport({
    port: 587,
    host: "smtp.office365.com",
    secure: false,
    auth: {
        user: 'drinkndash@hotmail.com',
        pass: 'N5aRN3KAxLgdfGW',
    },
});

//Database credentials.
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres',
    password: '123qweR',
    port: 5432,
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let totalMessages = 0; //So that each message sent get a unique id. For Flatlist purposes.

/**
 * Storage of users, games and ports
 */
const connectedUsers = [];
const createdGames = [];
const portsInUse = [];


wss.on("connection", function connection(ws) {
    ws.on("message", function incoming(message, isBinary) {

        if (message.toString().startsWith("LOGIN")) { //Handle user login.
            const userData = JSON.parse(message.toString().split(" ")[1]); //contains username and password
            const lookupUserQuery = `SELECT id, password FROM users WHERE username = $1;`;
            pool.query(lookupUserQuery, [userData.username.toUpperCase()], (error, result) => {
                if (result.rowCount > 0) {
                    const userId = result.rows[0].id;

                    const user = {
                        id: userId,
                        username: userData.username,
                        socket: ws
                    }

                    //Bypass login on refresh for connected users 
                    const knownUser = connectedUsers.find(user => user.username === userData.username);
                    if (knownUser) {
                        connectedUsers[connectedUsers.indexOf(knownUser)].socket = ws; //ensure correct socket is always used. 
                        ws.send("LOGIN " + JSON.stringify(knownUser));
                    } else {
                        //compare hashed passwords and if successful navigate them to Home screen.
                        Bcrypt.compare(userData.password, result.rows[0].password, (err, result) => {
                            if (!err) {
                                if (result) {
                                    if (ws.readyState === WebSocket.OPEN) {
                                        connectedUsers.push(user);
                                        ws.send("LOGIN " + JSON.stringify(user));
                                    }
                                } else {
                                    ws.send("INCORRECT");
                                }
                            } else {
                                console.error('Error comparing passwords:', err);
                            }
                        });
                    }

                } else {
                    ws.send("INCORRECT");
                }
            });
        } else if (message.toString().startsWith("REGISTER")) { //Handle registration of new account."
            const userData = JSON.parse(message.toString().split(" ")[1]); //Contains the email, username and hashed password
            const lookupUserQuery = `SELECT * FROM users WHERE email = $1 OR username = $2;`;
            const insertUserQuery = `INSERT INTO users (email, username, password, wins) VALUES ($1, $2, $3, 0) RETURNING id;`;

            pool.query(lookupUserQuery, [userData.email.toUpperCase(), userData.username.toUpperCase()], (error, result) => {
                if (result.rowCount < 1) {
                    pool.query(insertUserQuery, [userData.email.toUpperCase(), userData.username.toUpperCase(), userData.password], (error, result) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            const user = {
                                id: result.rows[0].id,
                                username: userData.username,
                                socket: ws
                            }
                            //Add user to the connected users array.
                            connectedUsers.push(user);
                            ws.send("LOGIN " + JSON.stringify(userData));
                        }
                    });
                } else {
                    ws.send("INCORRECT");
                }
            });
        } else if (message.toString().startsWith("CREATE")) { //Creation of new game.
            const userData = JSON.parse(message.toString().split(" ")[1]); //Contains username used for lobby naming and user retrieval.
            const host = connectedUsers.find(user => user.username === userData.username);
            const createLobbyQuery = `INSERT INTO lobbies (title, creatorId, totalPlayer) VALUES ($1, $2, 1) RETURNING id;`;
            const linkUserToLobby = `INSERT INTO userstolobbies (user_id, username, lobby_id, wins) VALUES ($1, $2, $3, 0)`;
            const lobbyName = `${host.username}'s Game`

            pool.query(createLobbyQuery, [lobbyName, host.id], (error, result) => {
                const lobbyId = result.rows[0].id;
                pool.query(linkUserToLobby, [host.id, host.username.toUpperCase(), lobbyId], (error, result) => {
                    if (result) {
                        let randomPort = Math.ceil(Math.random() * (5000 - 3000)) + 3000;
                        while (portsInUse.includes(randomPort)) {
                            randomPort = Math.Ceil(Math.random() * (5000 - 3000)) + 3000;
                        }

                        portsInUse.push(randomPort); //Each game needs unique port.

                        const game = {
                            id: lobbyId,
                            name: lobbyName,
                            host: host.id,
                            players: [ws], //The socket of creator is assigned at creation.
                            port: randomPort,
                            needPort: false
                        }
                        createdGames.push(game);
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send("LOBBY " + lobbyId);
                        }
                        const getLobbiesQuery = `SELECT * FROM lobbies`;

                        //Refresh the list of lobbies for every other user.
                        connectedUsers.map((user) => {
                            if (user.socket != ws) {
                                pool.query(getLobbiesQuery, (error, result) => {
                                    user.socket.send("LIST " + JSON.stringify(result.rows));
                                });
                            }
                        });
                    }
                });
            });
        } else if (message.toString().startsWith("LOBBYLIST")) { //Retrieve users in a lobby.
            const lobbyId = message.toString().split(" ")[1]; //contains the id of the lobby
            const getUserLobbiesQuery = `SELECT * FROM userstolobbies WHERE lobby_id = $1`;

            pool.query(getUserLobbiesQuery, [lobbyId], (error, result) => {
                if (result) {
                    //Used to populate the list of users in a lobby.
                    ws.send("LOBBYLIST " + JSON.stringify(result.rows));
                }
            });
        } else if (message.toString().startsWith("JOIN")) { //Join a game created by another user.

            const lobbyId = JSON.parse(message.toString().split(" ")[1]); //Contains id of lobby

            const joinLobbyQuery = `INSERT INTO userstolobbies (user_id, username, lobby_id, wins) values ($1, $2, $3, 0)`;
            const updateLobbySizeQuery = `UPDATE lobbies SET totalPlayer = totalPlayer + 1 WHERE id = $1;`
            const getLobbyHostQuery = `SELECT creatorid FROM lobbies WHERE id = $1`;

            const user = connectedUsers.find(user => user.socket === ws);

            pool.query(joinLobbyQuery, [user.id, user.username.toUpperCase(), lobbyId], (error, result) => {
                if (result) {
                    pool.query(updateLobbySizeQuery, [lobbyId]);
                    pool.query(getLobbyHostQuery, [lobbyId], (error, result) => {
                        const host = createdGames.find(game => game.host === result.rows[0].creatorid); //So that it only triggers once
                        //Notifies everyone in the lobby to refresh the list
                        host.players.forEach((player) => {
                            player.send("REFRESH");
                        });
                        host.players.push(ws);
                        ws.send("LOBBY"); //notifies user to navigate to the lobby screen
                    });
                }
            });
        } else if (message.toString().startsWith("BET")) { //Used to update the bet of a user in the database.
            const bet_message = message.toString().split(" ");
            const suit = bet_message[1];
            const bet = bet_message[2];

            const updateUserLobbyQuery = `UPDATE userstolobbies SET suit = $1, bet = $2 WHERE user_id = $3 RETURNING lobby_id;`
            const user = connectedUsers.find(user => user.socket === ws);

            pool.query(updateUserLobbyQuery, [suit, bet, user.id], (error, result) => {
                const lobby = createdGames.find(game => game.id === result.rows[0].lobby_id);
                lobby.players.forEach((player) => {
                    player.send("REFRESH"); //Updates the bet for everyone in the lobby.
                });
            });
        } else if (message.toString().startsWith("MSG")) { //Used to send messages to users in a lobby.
            const chat_message = message.toString().split(" "); //Contains message send
            const text = chat_message.slice(1);
            let textString = text.join(" ");

            const user = connectedUsers.find(user => user.socket === ws); //user is retrieved through socket 
            const retrieveLobbyId = `SELECT lobby_id FROM userstolobbies WHERE user_id = $1;`

            pool.query(retrieveLobbyId, [user.id], (error, result) => {
                const lobby = createdGames.find(game => game.id === result.rows[0].lobby_id);
                totalMessages++;
                const userMSG = {
                    id: totalMessages,
                    username: user.username,
                    message: textString
                }
                //Messages are handled by by the Chatbox component and not stored in the backend. 
                lobby.players.forEach((player) => {
                    player.send("MSG " + JSON.stringify(userMSG)); //Broadcast message to everyone in a specific lobby.
                });
            });
        } else if (message.toString().startsWith("WINNER")) { //Used to send a message to a user in a lobby that they need to drink.
            const loserData = JSON.parse(message.toString().split(" ")[1]);
            const sips = parseInt(message.toString().split(" ")[2]);
            const loser = connectedUsers.find((user) => user.id === loserData.userId);
            loser.socket.send("LOSER " + sips);
        } else if (message.toString().startsWith("CHANGEPASS")) { //Handles password change for user. 
            const currentPassword = message.toString().split(" ")[1]; //Password used for validation.  
            const newPassword = message.toString().split(" ")[2];

            const user = connectedUsers.find(user => user.socket === ws);
            const lookupUserQuery = `SELECT * FROM users WHERE id = $1;`;
            const updateUserQuery = `UPDATE users SET password = $1 WHERE id = $2;`

            pool.query(lookupUserQuery, [user.id], (error, result) => {
                if (result) {
                    Bcrypt.compare(currentPassword, result.rows[0].password, (err, result) => {
                        if (!err) {
                            if (ws.readyState === WebSocket.OPEN) {
                                if (result) {
                                    Bcrypt.hash(newPassword, 10, (err, hash) => { //Hashing and storing of new password
                                        if (!err) {
                                            pool.query(updateUserQuery, [hash, user.id]);
                                            ws.send("CORRECT");
                                        } else {
                                            console.error('Error hashing the password:', err);
                                        }
                                    });
                                } else {
                                    ws.send("INCORRECT");
                                }
                            }
                        }
                        else {
                            console.error('Error comparing passwords:', err);
                        }
                    });
                }
            });
        } else if (message.toString().startsWith("RESETPASS")) { //Handles Password Reset for user.
            const providedEmail = message.toString().split(" ")[1]; //Contains email for validation. 
            const lookupUserEmailQuery = `SELECT id, email FROM users WHERE email = $1;`;
            const updateUserQuery = `UPDATE users SET password = $1 WHERE id = $2;`
            pool.query(lookupUserEmailQuery, [providedEmail.toUpperCase()], (error, result) => {
                if (result.rowCount > 0) {
                    const newPassword = generator.generate({ length: 8, numbers: true }); //Random password generated by server. 
                    Bcrypt.hash(newPassword, 10, (err, hash) => { //Hashing of new password. 
                        if (!err) {
                            pool.query(updateUserQuery, [hash, result.rows[0].id]);
                            ws.send("CORRECT");

                            const mailOptions = {
                                from: 'drinkndash@hotmail.com',
                                to: providedEmail,
                                subject: 'New password requested.',
                                text: `Your new password for the DrinknDash app is: ${newPassword}.`
                            };

                            transporter.sendMail(mailOptions, (error, info) => { //Send the user an email containing the new password.
                                if (error) {
                                    return console.log(error);
                                }
                            });
                        } else {
                            console.error('Error hashing the password:', err);
                        }
                    });
                } else {
                    ws.send("INCORRECT");
                }
            })
        } else if (message.toString() === "LIST") { //Retrieve lobbies from database.
            //Used to Refresh the list of lobbies in the Home screen.
            const getLobbiesQuery = `SELECT * FROM lobbies`;
            pool.query(getLobbiesQuery, (error, result) => {
                ws.send("LIST " + JSON.stringify(result.rows));
            });
        } else if (message.toString() === "HOST") { //Determines if the User in the lobby is the Creator. 
            //Only hosts can start the game. 
            if (ws.readyState === WebSocket.OPEN) {
                const user = connectedUsers.find(user => user.socket === ws);
                const lobbyGame = createdGames.find(host => host.host === user.id);
                if (lobbyGame) { //First port is automatically assigned at creation. 
                    if (!lobbyGame.needPort) {
                        createdGames[createdGames.indexOf(lobbyGame)].needPort = true;
                        createGame(lobbyGame.port, lobbyGame.id);
                    } else { //All additonal games will have a new port. For every game a new server is created.
                        let newPort = Math.ceil(Math.random() * (5000 - 3000)) + 3000;
                        while (portsInUse.includes(newPort)) {
                            newPort = Math.Ceil(Math.random() * (5000 - 3000)) + 3000;
                        }
                        createdGames[createdGames.indexOf(lobbyGame)].port = newPort;
                        createGame(newPort, lobbyGame.id);
                    }
                    ws.send("HOST");
                }
            }
        } else if (message.toString() === "GAME") { //Starts the game for a lobby.
            const user = connectedUsers.find(user => user.socket === ws);
            const retrieveLobbyId = `SELECT lobby_id FROM userstolobbies WHERE user_id = $1;`

            pool.query(retrieveLobbyId, [user.id], (error, result) => {
                const lobby = createdGames.find(game => game.id === result.rows[0].lobby_id);
                //Every user in a lobby is notified to navigate to the Main (Game) screen
                lobby.players.forEach((player) => {
                    player.send(`GAME ${lobby.port}`);
                });
            });
        } else if (message.toString() === "LOGOUT") { //Log the user out. 
            const userData = connectedUsers.find(user => user.socket === ws);
            connectedUsers.splice(connectedUsers.indexOf(userData), 1);
        } else if (message.toString() === "WITHDRAW") { //Handles navigation back to Home screen. From Settings and Lobby.
            const lobbyUser = connectedUsers.find(user => user.socket === ws);
            const gameIndex = createdGames.findIndex(games => games.players.some(player => player === ws));

            const removeUserFromLobby = `DELETE FROM userstolobbies WHERE user_id = $1;`;
            const updateLobbySizeQuery = `UPDATE lobbies SET totalPlayer = totalPlayer - 1 WHERE id = $1;`
            const removelobby = `DELETE FROM lobbies where id = $1;`;
            const removeAllUsersFromLobby = `DELETE FROM userstolobbies WHERE lobby_id = $1;`;

            if (lobbyUser) {
                if (createdGames[gameIndex]) {
                    //Destroy the lobby if the Host leaves
                    if (createdGames[gameIndex].host === lobbyUser.id) {
                        pool.query(removelobby, [createdGames[gameIndex].id], (error, result) => {
                            console.log("Host has deleted the Game.");
                            pool.query(removeAllUsersFromLobby, [createdGames[gameIndex].id], (error, result) => {
                                createdGames[gameIndex].players.map(player => {
                                    player.send("CANCEL");
                                });
                                portsInUse.splice(portsInUse.indexOf(createdGames[gameIndex].port));
                                createdGames.splice(gameIndex, 1);
                            });
                        });
                    } else { //Regular user removed from game  
                        pool.query(removeUserFromLobby, [lobbyUser.id], (error, result) => {
                            pool.query(updateLobbySizeQuery, [createdGames[gameIndex].id]);
                            if (gameIndex >= 0) {
                                createdGames[gameIndex].players = createdGames[gameIndex].players.filter(player => player !== ws);
                                lobbyUser.socket.send("CANCEL");
                            }
                        });
                    }
                } else { //Used when navigating from Settings
                    ws.send("CANCEL");
                }
            }

        } else if (message.toString() === "DELETE") { //removes user from array and database.
            const userData = connectedUsers.find(user => user.socket === ws);
            const removeUserQuery = `DELETE FROM users WHERE id = $1;`;

            pool.query(removeUserQuery, [userData.id], (error, result) => {
                if (result) {
                    ws.send("DELETE");
                    connectedUsers.splice(connectedUsers.indexOf(userData), 1);
                }
            });
        }
    });
});

app.get("/", (req, res) => {
    res.send("Hello World!");
});

/**
 * 
 * @param {number} port - Automatically assigned and is used to communicate between player and game.
 * @param {number} lobbyId - For Notifying the game results and relaying which created games no longer active.
 */
function createGame(port, lobbyId) {
    const newApp = express();
    const newServer = http.createServer(newApp);
    const gameServer = new WebSocket.Server({ server: newServer });

    const deck = [];
    const penalty = [];
    let waiting = 0;
    let waitingPenalty = 0;

    /**
     * simulates a Randomized 52 playing card deck and removes the aces.
     * last 6 cards are used as punishment cards.
     * cards a removed from the back of the collection. 
     */
    function generateDeck() {
        const deckHolder = [];

        //generate a deck of 52 cards
        for (let i = 1; i < 53; i++) {
            deckHolder.push(i);
        }

        //remove aces from deck
        deckHolder.splice(0, 1);
        deckHolder.splice(12, 1);
        deckHolder.splice(24, 1);
        deckHolder.splice(36, 1);

        //shuffle deck
        for (let i = 0; i <= 47; i++) {
            let picked = Math.floor(Math.random() * deckHolder.length);
            deck.push(deckHolder[picked]);
            deckHolder.splice(picked, 1);
        }

        //remove last 6 cards to act as penalty cards
        for (let i = 0; i < 6; i++) {
            penalty.push(deck.pop());
        }
    }

    gameServer.on('connection', (gameClient) => {

        gameClient.on('message', async (message) => {
            // Handle messages from the new server
            setTimeout(() => {
                if (message.toString() === ("DRAW")) { //Notifies user which object to move forwards.
                    waiting++;
                    if (waiting == gameServer.clients.size) {
                        let card = deck.pop();
                        let horseNumber = Math.ceil(parseFloat(card / 13));

                        gameServer.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(`DRAW ${card} ${horseNumber}`);
                                waiting--;
                            }
                        });
                    }
                } else if (message.toString() === ("PENALTY")) { //Notifies user which object to move backwards.
                    waitingPenalty++;
                    if (waitingPenalty == gameServer.clients.size) {
                        let card = penalty.pop();
                        let penaltyNumber = Math.ceil(parseFloat(card / 13));

                        gameServer.clients.forEach(function each(client) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(`PENALTY ${card} ${penaltyNumber}`);
                                waitingPenalty--;
                            }
                        });
                    }
                } else if (message.toString().startsWith("END")) { //Handle post game 
                    waiting++;
                    if (waiting == gameServer.clients.size) {
                        const placements = JSON.parse(message.toString().split(" ")[1]); //contains an array containing the placements of the suits
                        const first = placements[0]; //at first index is the suit to reach the finish line. 
                        const losers = [];

                        const getUserLobbiesQuery = `SELECT * FROM userstolobbies WHERE lobby_id = $1;`;
                        pool.query(getUserLobbiesQuery, [lobbyId], (error, result) => {
                            if (result) {
                                result.rows.map((res) => { //retrieves users for the lobby  
                                    if (res) {
                                        if (res.suit === first.suit) { //update databases for winner
                                            const updateLobbyUserQuery = `UPDATE userstolobbies SET wins = wins + 1 WHERE user_id = $1;`;
                                            const updateUserWinsQuery = `UPDATE users SET wins = wins + 1 Where id = $1;`;
                                            pool.query(updateLobbyUserQuery, [res.user_id]);
                                            pool.query(updateUserWinsQuery, [res.user_id]);
                                        } else {
                                            losers.push({
                                                userId: res.user_id,
                                                username: res.username
                                            });
                                        }
                                    }
                                })
                            }
                        });
                        //Send results back to players.
                        setTimeout(() => {
                            gameServer.clients.forEach(function each(client) {
                                if (client.readyState === WebSocket.OPEN) { //sens back the 
                                    client.send(`ENDSCREEN ${lobbyId} ${first.suit} ${JSON.stringify(losers)}`);
                                    waiting--;
                                }
                            });
                        }, 2500);

                        setTimeout(() => {
                            // Close server
                            gameServer.close(() => {
                                console.log('WebSocket server closed');
                            });
                        }, 5000);
                    }
                }
            }, 750);
        });

        gameClient.on('close', () => {
            console.log('Client disconnected.');
        });
    });

    newServer.listen(port, () => {
        console.log(`The Game Server is listening to port ${port}`);
        generateDeck();
    });
}

server.listen(8080, () => {
    console.log("Main Server Listening to port 8080");
});