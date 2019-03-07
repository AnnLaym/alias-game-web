function init(wsServer, path, moderKey) {
    const
        fs = require('fs'),
        http = require("http"),
        express = require('express'),
        app = wsServer.app,
        registry = wsServer.users,
        EventEmitter = require("events"),
        channel = "alias";

    let defaultWords, reportedWordsData = [], reportedWords = [];

    fs.readFile(`${__dirname}/words.json`, "utf8", function (err, words) {
        defaultWords = JSON.parse(words);
        fs.readFile(`${registry.config.appDir || __dirname}/alias-moderated-words.json`, "utf8", function (err, words) {
            if (words)
                defaultWords = JSON.parse(words);
        });
    });

    fs.readFile(`${registry.config.appDir || __dirname}/alias-reported-words.txt`, {encoding: "utf-8"}, (err, data) => {
        if (data) {
            data.split("\n").forEach((row) => row && reportedWordsData.push(JSON.parse(row)));
            reportedWordsData.forEach((it) => !it.processed && reportedWords.push(it.word));
        }
    });

    app.get(path, function (req, res) {
        res.sendFile(`${__dirname}/public/app.html`);
    });
    app.use("/alias", express.static(`${__dirname}/public`));

    class GameState extends EventEmitter {
        constructor(hostId, hostData, userRegistry) {
            super();
            const room = {
                inited: true,
                hostId: hostId,
                phase: 0,
                spectators: new JSONSet(),
                playerNames: {},
                readyPlayers: new JSONSet(),
                onlinePlayers: new JSONSet(),
                roundTime: 60,
                currentBet: Infinity,
                goal: 20,
                currentWords: [],
                teams: {},
                wordIndex: 0,
                wordsEnded: false,
                level: 2
            };
            this.room = room;
            this.state = {
                activeWord: null,
                roomWordsList: null
            };
            this.lastInteraction = new Date();
            let timer;
            const
                send = (target, event, data) => userRegistry.send(target, event, data),
                update = () => {
                    send(room.onlinePlayers, "state", room);
                },
                rotatePlayers = (teamId) => {
                    if (room.currentTeam) {
                        const currentTeam = room.teams[teamId || room.currentTeam],
                            currentPlayer = currentTeam.currentPlayer,
                            currentPlayerKeys = [...currentTeam.players],
                            indexOfCurrentPlayer = currentPlayerKeys.indexOf(currentTeam.currentPlayer);
                        if (indexOfCurrentPlayer === currentTeam.players.size - 1)
                            currentTeam.currentPlayer = currentPlayerKeys[0];
                        else
                            currentTeam.currentPlayer = currentPlayerKeys[indexOfCurrentPlayer + 1];
                        if (room.currentPlayer === currentPlayer)
                            room.currentPlayer = currentTeam.currentPlayer;
                    }
                },
                rotateTeams = () => {
                    if (room.currentTeam) {
                        const
                            teamKeys = Object.keys(room.teams),
                            indexOfCurrentTeam = teamKeys.indexOf(room.currentTeam);
                        if (indexOfCurrentTeam === teamKeys.length - 1)
                            room.currentTeam = teamKeys[0];
                        else
                            room.currentTeam = teamKeys[indexOfCurrentTeam + 1];
                        if (!room.teams[room.currentTeam].currentPlayer)
                            room.teams[room.currentTeam].currentPlayer = [...room.teams[room.currentTeam].players][0];
                        room.currentPlayer = room.teams[room.currentTeam].currentPlayer;
                    }
                    room.readyPlayers.clear();
                },
                leaveTeams = (user, exceptId) => {
                    if (room.currentPlayer === user)
                        rotatePlayers();
                    if (room.currentTeam && room.teams[room.currentTeam] && room.teams[room.currentTeam].players.size === 1)
                        rotateTeams();
                    Object.keys(room.teams).forEach(teamId => {
                        if (teamId !== exceptId && room.teams[teamId].players.delete(user) && room.teams[teamId].players.size === 0)
                            delete room.teams[teamId];
                    });
                    if (room.currentPlayer === user)
                        room.currentPlayer = null;
                    if (!room.teams[room.currentTeam])
                        room.currentTeam = null;
                    room.readyPlayers.delete(user);
                },
                calcWordPoints = () => {
                    let wordPoints = 0;
                    room.currentWords.forEach(word => wordPoints += word.points);
                    Object.keys(room.teams).forEach(teamId => {
                        if (room.teams[teamId].wordPoints !== undefined)
                            room.teams[teamId].wordPoints = wordPoints < 0 ? 0 : wordPoints;
                    });
                },
                addWordPoints = () => {
                    Object.keys(room.teams).forEach(teamId => {
                        const team = room.teams[teamId];
                        if (team.wordPoints !== undefined) {
                            team.score += team.wordPoints;
                            delete team.wordPoints;
                        }
                    });
                },
                stopTimer = () => {
                    room.timer = null;
                    clearInterval(timer);
                },
                endRound = () => {
                    if (this.state.activeWord)
                        room.currentWords.push({
                            points: 1,
                            word: this.state.activeWord,
                            reported: !!~reportedWords.indexOf(this.state.activeWord)
                        });
                    send(room.onlinePlayers, "active-word", null);
                    this.state.activeWord = undefined;
                    calcWordPoints();
                    if (room.phase !== 1) {
                        rotatePlayers();
                        rotateTeams();
                    }
                    stopTimer();
                    room.phase = 1;
                },
                startTimer = () => {
                    room.timer = room.roundTime * 1000;
                    timer = setInterval(() => {
                        room.timer -= 100;
                        if (room.timer <= 0) {
                            endRound();
                            send(room.onlinePlayers, "timer-end");
                            update();
                        }
                    }, 100);
                },
                resetOrder = () => {
                    Object.keys(room.teams).forEach(teamId => {
                        const team = room.teams[teamId];
                        team.currentPlayer = [...team.players][0];
                    });
                    room.currentTeam = Object.keys(room.teams)[0];
                    room.currentPlayer = room.teams[room.currentTeam] && room.teams[room.currentTeam].currentPlayer;
                },
                restartGame = () => {
                    addWordPoints();
                    room.phase = 0;
                    room.currentWords = [];
                    room.readyPlayers.clear();
                    //room.wordIndex = 0;
                    room.wordsEnded = false;
                    Object.keys(room.teams).forEach(teamId => {
                        const team = room.teams[teamId];
                        delete team.wordPoints;
                        team.score = 0;
                    });
                    resetOrder();
                },
                selectWordSet = (wordSet, user) => {
                    if (!isNaN(parseFloat(wordSet))) {
                        room.currentWords = [];
                        const difficulty = parseFloat(wordSet);
                        if (!~[1, 2, 3].indexOf(difficulty) > 0) {
                            if (user)
                                send(user, "message", "You did something wrong");
                        } else {
                            room.level = difficulty;
                            this.state.roomWordsList = shuffleArray([...defaultWords[difficulty]]);
                            room.wordIndex = 0;
                            room.wordsEnded = false;
                        }
                        update();
                    }
                },
                removePlayer = playerId => {
                    Object.keys(room.teams).forEach(teamId => {
                        const team = room.teams[teamId];
                        if (team.players.delete(playerId)) {
                            if (team.players.size === 0) {
                                if (room.currentTeam === teamId)
                                    rotateTeams();
                                delete room.teams[teamId];
                            } else if (team.currentPlayer === playerId)
                                rotatePlayers(teamId);
                        }
                    });
                    room.readyPlayers.delete(playerId);
                    if (room.spectators.has(playerId) || !room.onlinePlayers.has(playerId)) {
                        room.spectators.delete(playerId);
                        delete room.playerNames[playerId];
                        registry.disconnect(playerId, "You was removed");
                    } else
                        room.spectators.add(playerId);
                },
                setTurn = playerId => {
                    Object.keys(room.teams).forEach(teamId => {
                        const team = room.teams[teamId];
                        [...team.players].forEach(teamPlayerId => {
                            if (teamPlayerId === playerId) {
                                team.currentPlayer = playerId;
                                room.currentPlayer = playerId;
                                room.currentTeam = teamId;
                                room.readyPlayers.clear();
                            }
                        })
                    });
                },
                userJoin = (data) => {
                    const user = data.userId;
                    if (!room.playerNames[user])
                        room.spectators.add(user);
                    room.onlinePlayers.add(user);
                    room.playerNames[user] = data.userName.substr && data.userName.substr(0, 60);
                    if (!this.state.roomWordsList)
                        selectWordSet(2);
                    if (room.currentPlayer === user && this.state.activeWord)
                        send(user, "active-word", {
                            word: this.state.activeWord,
                            reported: !!~reportedWords.indexOf(this.state.activeWord)
                        });
                    update();
                },
                userLeft = (user) => {
                    room.onlinePlayers.delete(user);
                    if (room.spectators.has(user))
                        delete room.playerNames[user];
                    room.spectators.delete(user);
                    room.readyPlayers.delete(user);
                    if (room.onlinePlayers.size === 0)
                        stopTimer();
                    update();
                },
                userEvent = (user, event, data) => {
                    this.lastInteraction = new Date();
                    try {
                        if (this.eventHandlers[event])
                            this.eventHandlers[event](user, data[0], data[1], data[2]);
                    } catch (error) {
                        console.error(error);
                        registry.log(error.message);
                    }
                };
            this.userJoin = userJoin;
            this.userLeft = userLeft;
            this.userEvent = userEvent;
            this.eventHandlers = {
                "team-join": (user, id) => {
                    if (id === "new") {
                        id = makeId();
                        room.teams[id] = {score: 0, players: new JSONSet()};
                    }
                    if (room.teams[id] && !room.teams[id].players.has(user)) {
                        leaveTeams(user, id);
                        room.spectators.delete(user);
                        room.teams[id].players.add(user);
                        update();
                    }
                },
                "spectators-join": (user) => {
                    leaveTeams(user);
                    room.spectators.add(user);
                    update();
                },
                "action": (user) => {
                    if (room.phase === 0 && room.hostId === user && Object.keys(room.teams).length > 0) {
                        room.phase = 1;
                        room.currentTeam = room.currentTeam || Object.keys(room.teams)[0];
                        const currentTeam = room.teams[room.currentTeam];
                        currentTeam.currentPlayer = currentTeam.currentPlayer || [...currentTeam.players][0];
                        room.currentPlayer = currentTeam.currentPlayer;
                    } else if (room.phase === 1) {
                        if (room.currentPlayer !== user || room.readyPlayers.size !== room.teams[room.currentTeam].players.size)
                            if (room.readyPlayers.has(user))
                                room.readyPlayers.delete(user);
                            else
                                room.readyPlayers.add(user);
                        else {
                            room.phase = 2;
                            room.readyPlayers.clear();
                            addWordPoints();
                            room.currentWords = [];
                            startTimer();
                        }
                    }
                    if (room.phase === 2 && room.currentPlayer === user) {
                        if (room.currentWords.length > 99)
                            endRound();
                        room.teams[room.currentTeam].wordPoints = 0;
                        if (room.currentBet > room.currentWords.length + 1) {
                            if (room.wordIndex < this.state.roomWordsList.length) {
                                const randomWord = this.state.roomWordsList[room.wordIndex++];
                                if (this.state.activeWord)
                                    room.currentWords.push({
                                        points: 1,
                                        word: this.state.activeWord,
                                        reported: !!~reportedWords.indexOf(this.state.activeWord)
                                    });
                                this.state.activeWord = randomWord;
                                send(user, "active-word", {
                                    word: this.state.activeWord,
                                    reported: !!~reportedWords.indexOf(this.state.activeWord)
                                });
                            } else {
                                endRound();
                                room.wordsEnded = true;
                            }
                        } else
                            endRound();
                    }
                    update();
                },
                "set-score": (user, data) => {
                    if (room.hostId === user && room.teams[data.teamId]) {
                        const team = room.teams[data.teamId];
                        if (team && !isNaN(parseInt(data.score)))
                            team.score = parseInt(data.score);
                        update();
                    }
                },
                "stop-game": (user) => {
                    if (room.hostId === user) {
                        endRound();
                        room.phase = 0;
                        update();
                    }
                },
                "set-word-points": (user, value) => {
                    if (room.hostId === user || Object.keys(room.teams).some((teamId) => room.teams[teamId].players.has(user))) {
                        room.currentWords = value;
                        room.readyPlayers.delete(room.currentPlayer);
                        calcWordPoints();
                        update();
                    }
                },
                "change-name": (user, value) => {
                    if (value)
                        room.playerNames[user] = value.substr && value.substr(0, 60);
                    update();
                },
                "remove-player": (user, playerId) => {
                    if (room.hostId === user && playerId)
                        removePlayer(playerId);
                    update();
                },
                "shuffle-players": (user) => {
                    if (room.hostId === user) {
                        let currentPlayers = [];
                        Object.keys(room.teams).forEach(teamId => {
                            const team = room.teams[teamId];
                            currentPlayers = currentPlayers.concat([...team.players]);
                            team.players = new JSONSet();
                        });
                        shuffleArray(currentPlayers);
                        while (currentPlayers.length > 0) {
                            Object.keys(room.teams).forEach(teamId => {
                                if (currentPlayers.length > 0)
                                    room.teams[teamId].players.add(currentPlayers.pop());
                            });
                        }
                        resetOrder();
                        update();
                    }
                },
                "restart-game": (user) => {
                    if (room.hostId === user)
                        restartGame();
                    update();
                },
                "set-round-time": (user, time) => {
                    if (room.hostId === user)
                        room.roundTime = time;
                    update();
                },
                "set-goal": (user, goal) => {
                    if (room.hostId === user)
                        room.goal = goal;
                    update();
                },
                "select-word-set": (user, wordSet) => {
                    if (room.phase === 0 && room.hostId === user)
                        selectWordSet(wordSet, user);
                },
                "give-host": (user, playerId) => {
                    if (room.hostId === user && playerId) {
                        room.hostId = playerId;
                        this.emit("host-changed", user, playerId);
                    }
                    update();
                },
                "set-turn": (user, playerId) => {
                    if (room.hostId === user && playerId)
                        setTurn(playerId);
                    update();
                },
                "setup-words": (user, wordsURL) => {
                    if (room.hostId === user && wordsURL && wordsURL.substr(0, 4) === "http")
                        try {
                            http.get(wordsURL.replace("https", "http"),
                                res => {
                                    let str = "";
                                    res.on("data", (chunk) => {
                                        str += chunk;
                                    });

                                    res.on("end", () => {
                                        const newWords = str.toString().split("\r\n");
                                        if (newWords.length > 0) {
                                            this.state.roomWordsList = shuffleArray(newWords);
                                            room.wordIndex = 0;
                                            room.wordsEnded = false;
                                            room.level = 0;
                                            update();
                                        } else
                                            send(user, "message", `You did something wrong`);
                                    });
                                },
                                err => {
                                    send(user, "message", `You did something wrong: ${err.message}`);
                                }
                            );
                        } catch (err) {
                            send(user, "message", `You did something wrong: ${err}`);
                        }
                },
                "report-word": (user, word, currentLevel, level) => {
                    if (!~reportedWords.indexOf(word) && room.currentWords.some((it) => it.word === word)) {
                        const reportInfo = {
                            datetime: +new Date(),
                            user: user,
                            playerName: room.playerNames[user],
                            word: word,
                            currentLevel: currentLevel,
                            level: level,
                            processed: false,
                            approved: null
                        };
                        room.currentWords.filter((it) => it.word === word)[0].reported = true;
                        reportedWordsData.push(reportInfo);
                        reportedWords.push(word);
                        fs.appendFile(`${registry.config.appDir || __dirname}/alias-reported-words.txt`, `${JSON.stringify(reportInfo)}\n`, () => {
                        });
                        update();
                    }
                },
                "get-word-reports-data": (user) => {
                    send(user, "word-reports-data", reportedWordsData);
                },
                "apply-words-moderation": (user, sentModerKey, moderData) => {
                    if (moderData && moderData[0] && sentModerKey === moderKey) {
                        let hasChanges = false;
                        moderData.forEach((moderData) => {
                            reportedWordsData.some((reportData) => {
                                if (reportData.datetime === moderData.datetime && !reportData.processed) {
                                    hasChanges = true;
                                    reportData.processed = true;
                                    reportData.approved = moderData.approved;
                                    Object.assign(moderData, reportData);
                                    reportedWords.splice(reportedWords.indexOf(moderData.word), 1);
                                    if (reportData.approved) {
                                        if (!reportData.newWord) {
                                            defaultWords[reportData.currentLevel].splice(defaultWords[reportData.currentLevel].indexOf(reportData.word), 1);
                                            defaultWords[reportData.level].push(reportData.word);
                                        } else {
                                            reportData.wordList.filter((word) =>
                                                !~defaultWords[1].indexOf(word)
                                                && !~defaultWords[2].indexOf(word)
                                                && !~defaultWords[3].indexOf(word)).forEach((word) => defaultWords[reportData.level].push(word));
                                        }
                                    }
                                    return true;
                                }
                            });
                        });
                        if (!hasChanges)
                            send(user, "word-reports-request-status", "Success");
                        else
                            fs.writeFile(`${registry.config.appDir || __dirname}/alias-moderated-words.json`, JSON.stringify(defaultWords, null, 4), (err) => {
                                if (!err) {
                                    fs.writeFile(`${registry.config.appDir || __dirname}/alias-reported-words.txt`,
                                        reportedWordsData.map((it) => JSON.stringify(it)).join("\n") + "\n",
                                        () => {
                                            let aliasPlayers = [];
                                            registry.roomManagers.forEach((roomManager, roomPath) => {
                                                if (roomPath === path) {
                                                    roomManager.rooms.forEach((roomData) => {
                                                        aliasPlayers = aliasPlayers.concat([...roomData.room.onlinePlayers]);
                                                    });
                                                }
                                            });
                                            userRegistry.send(aliasPlayers, "word-report-notify", moderData);
                                        }
                                    );
                                    send(user, "word-reports-data", reportedWordsData);
                                    send(user, "word-reports-request-status", "Success");
                                } else
                                    send(user, "word-reports-request-status", err.message)
                            });
                    } else
                        send(user, "word-reports-request-status", "Wrong key");
                },
                "add-words": (user, words, level) => {
                    if (words && words.length < 2500) {
                        let wordList = [...(new Set(words.split("\n")))];
                        if (wordList.length <= 50) {
                            wordList = wordList.filter((word) => word.toLowerCase
                                && word.length <= 50 && word.trim().length > 0
                                && !~defaultWords[1].indexOf(word)
                                && !~defaultWords[2].indexOf(word)
                                && !~defaultWords[3].indexOf(word)).map((word) => word.toLowerCase());
                            if (wordList.length > 0) {
                                const reportInfo = {
                                    datetime: +new Date(),
                                    user: user,
                                    playerName: room.playerNames[user],
                                    newWord: true,
                                    wordList,
                                    level: level,
                                    processed: false,
                                    approved: null
                                };
                                reportedWordsData.push(reportInfo);
                                fs.appendFile(`${registry.config.appDir || __dirname}/alias-reported-words.txt`, `${JSON.stringify(reportInfo)}\n`, () => {
                                });
                            }
                        }
                    }
                }
            };
        }

        getPlayerCount() {
            return Object.keys(this.room.playerNames).length;
        }

        getActivePlayerCount() {
            return this.room.onlinePlayers.size;
        }

        getLastInteraction() {
            return this.lastInteraction;
        }

        getSnapshot() {
            return {
                room: this.room,
                state: {
                    activeWord: this.state.activeWord,
                    roomWordsList: null

                }
            };
        }

        setSnapshot(snapshot) {
            Object.assign(this.room, snapshot.room);
            this.state = snapshot.state;
            this.state.roomWordsList = shuffleArray([...defaultWords[this.room.level]]);
            this.room.phase = 0;
            this.room.currentBet = Infinity;
            this.room.timer = null;
            this.room.onlinePlayers = new JSONSet();
            this.room.spectators = new JSONSet();
            this.room.readyPlayers = new JSONSet(this.room.readyPlayers);
            Object.keys(this.room.teams).forEach((teamId) => {
                this.room.teams[teamId].players = new JSONSet(this.room.teams[teamId].players);
            });
            this.room.onlinePlayers.clear();
        }
    }

    function makeId() {
        let text = "";
        const possible = "abcdefghijklmnopqrstuvwxyz0123456789";

        for (let i = 0; i < 5; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }

    function shuffleArray(array) {
        let currentIndex = array.length, temporaryValue, randomIndex;
        while (0 !== currentIndex) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex -= 1;
            temporaryValue = array[currentIndex];
            array[currentIndex] = array[randomIndex];
            array[randomIndex] = temporaryValue;
        }
        return array;
    }

    class JSONSet extends Set {
        constructor(iterable) {
            super(iterable)
        }

        toJSON() {
            return [...this]
        }
    }

    registry.createRoomManager(path, channel, GameState);
}

module.exports = init;
