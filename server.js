import HaxballJS from 'haxball.js';
import { readFile } from 'fs/promises';
import { I18n } from 'i18n-js';

const HEADLESS_TOKEN = 'thr1.AAAAAGoxtexMDkPN9t-yeA.McYUbIggpgE';

// Game mode configuration
const TEAM_SIZE = 2;
const STARTING_MATCHES_COUNT = 1;
const MINIMUM_PLAYERS = TEAM_SIZE * STARTING_MATCHES_COUNT * 2;

const CAPTAIN_VOTING_TIME = 1;
const TEAM_CONFIG_TIME = 2;
const MATCH_INTERMISSION = 2;

// Command configuration
const COMMANDS = {
    'VOTE_CAPTAIN': 'capitao',
    'SELECT_TEAM': 'selecao',
    'DEFINITIVE_RESET': 'reiniciar',
    'CONFIGURE': 'configurar',
    'ROUND_LOG': 'rodada'
};

const ADMIN_COMMANDS = new Set([
    COMMANDS.DEFINITIVE_RESET,
    COMMANDS.CONFIGURE
]);

// Core match configuration
const matchConfiguration = {
    map: 'futsalx3',
    'score-limit': 1,
    'time-limit': 1
};

const baseConfigurationCommand = `!${COMMANDS.CONFIGURE} ` + Object.entries(matchConfiguration).map(([ key, value ]) => `${key}=${value}`).join(' ');

// Styles used to send server-wide messages
const ANNOUNCEMENT_STYLES = {
    DEFAULT: [ 0xFFFFFF, 'bold' ],
    INSTRUCTION: [ 0x00FF00, 'bold' ],
    INFORMATION: [ 0x999999, 'italic' ],
    ERROR: [ 0xFF0000, 'bold' ]
};

// Internationalization library
const i18n = new I18n({
    'pt-BR': {
        playersLeft: {
            one: 'FALTA 1 JOGADOR',
            other: 'FALTAM %{count} JOGADORES'
        },
        playersToVote: {
            one: 'FALTA 1 JOGADOR VOTAR',
            other: 'FALTAM %{count} JOGADORES VOTAREM'
        },
        teamsToConfigure: {
            one: 'FALTA 1 TIME SER CONFIGURADO...',
            other: 'FALTAM %{count} SEREM CONFIGURADOS...'
        },
        seconds: {
            one: '1 SEGUNDO',
            other: '%{count} SEGUNDOS'
        }
    }
});

i18n.locale = 'pt-BR';

// Function to read JSON file
const readData = async (path) => {
    try {
        const rawData = await readFile(path, 'utf-8');
        const parsedData = JSON.parse(rawData);
        return parsedData;
    } catch(error) {
        console.log('Error reading or parsing file: ', error);
    }
}

// Reads the JSON file of the available kits and creates an array with all the names
let kitData = await readData('./kits.json');
const kitNameArray = Object.keys(kitData.teams);

// Utility functions
const shuffle = (array) => {
    const shuffled = [...array];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled;
};

const sleep = (ms, cancelEvent) => new Promise((resolve) => {
    const timer = setTimeout(() => {
        cancelEvent?.disconnect(onCancel);
        resolve();
    }, ms * 1000);

    const onCancel = () => {
        clearTimeout(timer);
        resolve();
    };

    cancelEvent?.connect(onCancel);
});

const convertToGrid = (gridData, numColumns = 3, padding = 4) => {
    const rows = [];
    const colWidths = Array(numColumns).fill(0);
    for (let i = 0; i < gridData.length; i++) {
        const colIndex = i % numColumns;
        if (colIndex === 0) rows.push([]);

        const str = gridData[i];
        rows[rows.length - 1].push(str);
        colWidths[colIndex] = Math.max(colWidths[colIndex], str.length);
    }

    return rows.map(row => row.reduce((acc, str, colIndex) => {
        return acc + str.padEnd(colWidths[colIndex] + padding);
    }, '')).join('\n');
};

const formatTeamName = (arr, teamName) => {
    return arr.filter(name => name.toLowerCase() === teamName.toLowerCase())[0];
};

const addLines = (text, char = '=') => {
    const line = char.repeat(text.length * 2);
    return `${line}\n${text}\n${line}`;
};

// Derived class to allow for a custom AbortionController with a threshold (needs to be emitted n times to cancel, very useful)
class CancelEvent extends EventTarget {
    constructor(threshold = 1) {
        super();
        this.threshold = threshold;
    }

    connect(callback) {
        this.addEventListener('cancel', callback);
    }

    disconnect(callback) {
        this.removeEventListener('cancel', callback);
    }

    emit() {
        this.threshold--;
        if (this.threshold > 0) return;
        this.dispatchEvent(new CustomEvent('cancel'));
    }
}

HaxballJS().then((HBInit) => {
    const room = HBInit({
        token: HEADLESS_TOKEN,
        roomName: 'COPA DO MUNDO HAXBALL',
        maxPlayers: MINIMUM_PLAYERS,
        public: false,
        noPlayer: true
    });

    room.onRoomLink = (link) => console.log("Room link: ", link);

    room.setTeamsLock(true);

    const players = [[], [], []];

    const getPlayerCount = () => {
        let count = 0;
        for (const teamPlayers of players) {
            count += teamPlayers.length;
        }
        return count;
    };

    const changePlayerTeam = (playerId, targetTeamId) => {
        for (const teamPlayers of players) {
            const index = teamPlayers.indexOf(playerId);
            if (index !== -1) {
                teamPlayers.splice(index, 1);
                break;
            }
        }

        if (targetTeamId) {
            players[targetTeamId].push(playerId);
            room.setPlayerTeam(playerId, targetTeamId);
        }
    };

    const clearTeam = (teamId) => {
        if (teamId == 0) return;
        for (const playerId of players[teamId]) {
            players[0].push(playerId);
            room.setPlayerTeam(playerId, 0);
        }
        players[teamId].length = 0;
    };

    const clearAllTeams = () => {
        for (let i = 1; i <= 2; i++) clearTeam(i);
    };

    const sendAnnouncement = (message, playerId, style = 'DEFAULT', customColor) => {
        const [ color, st ] = ANNOUNCEMENT_STYLES[style];
        room.sendAnnouncement(message, playerId, customColor || color, st, 2);
    };

    const teams = [];
    const team_by_player = new Map();
    const has_voted = new Set();
    const matches = [];
    let currentMatchIndex = -1;
    let configuringTeamIndex = -1;
    const selected_teams = new Set();
    let cancelEvent;

    const getAvailableTeams = () => kitNameArray.filter(name => !selected_teams.has(name.toLowerCase()));

    const getTeamName = (team, style = 'toUpperCase') => {
        return team.metadata.name[style]();
    };

    const getRandomTeam = () => {
        const availableTeams = getAvailableTeams();
        return availableTeams[Math.floor(Math.random() * availableTeams.length)];
    }

    const getPrimaryKitColor = (teamName) => {
        const data = kitData.teams[teamName];
        if (data) return parseInt(data.discColors[data.discColors.length - 1], 16);
    };

    const getRoundName = () => {
        const roundLength = matches.length;
        switch (roundLength) {
            case 1:
                return 'FINAL';
            case 2:
                return 'SEMIFINAIS';
            case 4:
                return 'QUARTAS DE FINAL';
            case 8:
                return 'OITAVAS DE FINAL';
        }
    }

    const getRoundLog = () => {
        return `[${getRoundName()}] DADOS DA RODADA:\n` + matches.map((match, index) => {
            const red = match[0];
            const blue = match[1];
            const result = match[2];

            let resultMessage;
            if (match.length > 2) resultMessage = `VENCEDOR: ${getTeamName(result.winner)} POR ${result.maxScore} A ${result.minScore}`;
            else if (index === currentMatchIndex) resultMessage = 'EM PROGRESSO...';
            else resultMessage = 'AINDA POR VIR...';

            return `[${index + 1}] ${getTeamName(red)} x ${getTeamName(blue)}` + ' | ' + resultMessage;
        }).join('\n');
    };

    const setKit = (teamId, kitName) => {
        const data = kitData.teams[kitName];
        if (!data) return;

        const avatarColor = parseInt(data.avatarColor, 16);
        const discColors = data.discColors.map(color => parseInt(color, 16));

        room.setTeamColors(teamId, data.angle, avatarColor, discColors);
    };

    const getNextRound = () => {
        const winners = [];
        for (const [red, blue, result] of matches) {
            winners.push(result.winner);
        }

        matches.length = 0;
        currentMatchIndex = 0;

        if (winners.length === 1) return winners[0];

        for (let i = 0; i < winners.length; i += 2) {
            matches.push([ winners[i], winners[i + 1] ]);
        }

        return null;
    };

    let gameInProgress = false;
    const startMatch = async (customRoundName) => {
        if (gameInProgress) return;
        gameInProgress = true;

        currentMatchIndex++;
        let champion;
        if (currentMatchIndex >= matches.length) champion = getNextRound();

        if (matches.length > 0) {
            sendAnnouncement(`[${customRoundName || getRoundName()}]`);
        } else {
            sendAnnouncement(addLines(`O CAMPEÃO ABSOLUTO DA COPA DO MUNDO: ${getTeamName(champion)}!`), null, 'DEFAULT', getPrimaryKitColor(champion.metadata.name));

            await sleep(MATCH_INTERMISSION);

            reset();
            update('RECOMEÇANDO, ESTÁ PREPARADO?')

            return;
        }

        const match = matches[currentMatchIndex];
        for (let i = 0; i < 2; i++) {
            const team = match[i];

            setKit(i + 1, team.metadata.name);

            for (const playerId of team.players) {
                changePlayerTeam(playerId, i + 1);
            }
        }

        const red = match[0];
        const blue = match[1];

        const announcementText = `EM ${i18n.t('seconds', { count: MATCH_INTERMISSION })}, VEM AÍ ${getTeamName(red)} x ${getTeamName(blue)}!`;
        sendAnnouncement(addLines(announcementText));

        await sleep(MATCH_INTERMISSION);

        room.startGame();
    };

    const stopMatch = () => {
        if (!gameInProgress) return;
        gameInProgress = false;

        const match = matches[currentMatchIndex];
        const red = match[0];
        const blue = match[1];

        const { red: scoreRed, blue: scoreBlue } = room.getScores();

        const winner = scoreRed > scoreBlue ? red : blue;
        const loser = scoreRed > scoreBlue ? blue : red;
        loser.lost = true;

        const maxScore = Math.max(scoreRed, scoreBlue);
        const minScore = Math.min(scoreRed, scoreBlue);

        match.push({ winner, maxScore, minScore });

        sendAnnouncement(addLines(`${getTeamName(winner)} VENCEU ${getTeamName(loser)} POR ${maxScore} a ${minScore}!`));

        startMatch();
    };

    const configureFallbackMode = () => {
        const targetTeamSize = Math.min(Math.floor(getPlayerCount()/2), 3);
        if (targetTeamSize < 1 || players[0].length % 2 !== 0) return;

        const plrs = [
            [...players[1]],
            [...players[2]]
        ];

        let teamIndex = 0;
        let specIndex = 0;
        while (Math.min(plrs[0].length, plrs[1].length) < targetTeamSize) {
            if (specIndex >= players[0].length) break;
            const spec = players[0][specIndex];

            plrs[teamIndex].push(spec);

            teamIndex = teamIndex === 0 ? 1 : 0;
            specIndex++;
        }

        if (matches.length === 0 || specIndex > 0) {
            const redKit = getRandomTeam();
            selected_teams.add(redKit.toLowerCase());

            const blueKit = getRandomTeam();
            selected_teams.add(blueKit.toLowerCase());

            matches[0] = [
                { players: plrs[0], captain: plrs[0][0], metadata: { name: redKit } },
                { players: plrs[1], captain: plrs[1][0], metadata: { name: blueKit } }
            ];
            currentMatchIndex = -1;

            startMatch();
        }
        else {
            matches[0][0].players = plrs[0];
            matches[0][1].players = plrs[1];

            for (let i = 0; i < 2; i++) {
                for (const playerId of matches[0][i].players) changePlayerTeam(playerId, i + 1);
            }
        }

        team_by_player.clear();
        for (let i = 0; i < 2; i++) {
            for (const playerId of matches[0][i].players) team_by_player.set(playerId, matches[0][i]);
        }
    };

    const canVoteForCaptain = () => TEAM_SIZE >= 1;

    const update = async (startMessage = `A COPA DO MUNDO VAI COMEÇAR! ESPERE PARA CONFIGURAR O SEU TIME...`) => {
        const playersLeft = MINIMUM_PLAYERS - getPlayerCount();
        if (playersLeft > 0) {
            configureFallbackMode();

            return sendAnnouncement(`${i18n.t('playersLeft', { count: playersLeft })} PARA COMEÇAR A COPA, AGUARDE...`, null, 'INFORMATION');
        }

        reset();

        sendAnnouncement(startMessage, null, 'INSTRUCTION');
        await sleep(MATCH_INTERMISSION);

        const shuffled_specs = shuffle(players[0]);
        for (let i = 0; i < MINIMUM_PLAYERS; i += TEAM_SIZE) {
            const teamPlayers = [];
            const metadata = { name: 'DEFAULT', captainVotes: [] };
            for (let j = 0; j < TEAM_SIZE; j++) {
                const playerId = shuffled_specs[i + j];
                teamPlayers.push(playerId);
                metadata.captainVotes[j] = 0;
            }

            const team = { players: teamPlayers, captain: -1, metadata };
            teams.push(team);

            for (const playerId of team.players) {
                team_by_player.set(playerId, team);
            }
        }

        if (canVoteForCaptain()) {
            sendAnnouncement(`VOTE NO CAPITÃO DO SEU TIME USANDO O COMANDO !${COMMANDS.VOTE_CAPTAIN} <id>\nVOCÊ TEM ${i18n.t('seconds', { count: CAPTAIN_VOTING_TIME })}!`, null, 'INSTRUCTION');
            for (const team of teams) {
                let announcementText = 'Jogadores da seleção:\n';
                for (let i = 0; i < team.players.length; i++) {
                    const playerId = team.players[i];
                    const playerObject = room.getPlayer(playerId);
                    announcementText += `[id: ${i + 1}] ${playerObject.name}\n`;
                }

                for (const playerId of team.players) {
                    sendAnnouncement(announcementText, playerId, 'INFORMATION');
                }
            }

            cancelEvent = new CancelEvent(MINIMUM_PLAYERS);
            await sleep(CAPTAIN_VOTING_TIME, cancelEvent);
        }

        for (let i = 0; i < teams.length; i++) {
            const team = teams[i];

            if (canVoteForCaptain()) {
                const captainVotes = team.metadata.captainVotes;
                const winnerIndex = captainVotes.indexOf(Math.max(...captainVotes));
                team.captain = team.players[winnerIndex];
            } else {
                team.captain = team.players[0];
            }

            const captainName = room.getPlayer(team.captain).name;
            for (const playerId of team.players) {
                const captainText = playerId === team.captain
                    ? 'VOCẼ'
                    : captainName;
                sendAnnouncement(`O CAPITÃO DO SEU TIME É ${captainText}!`, playerId);
            }
        }

        for (const team of teams) {
            for (const playerId of team.players) {
                if (playerId === team.captain) {
                    const availableTeams = getAvailableTeams();
                    sendAnnouncement('SELEÇÕES DISPONÍVEIS:\n' + convertToGrid(availableTeams), playerId, 'INFORMATION');

                    sendAnnouncement(`ESCOLHA UMA SELEÇÃO USANDO O COMANDO !${COMMANDS.SELECT_TEAM} <nome>\nVOCÊ TEM ${i18n.t('seconds', { count: TEAM_CONFIG_TIME })}!`, playerId, 'INSTRUCTION');
                } else {
                    sendAnnouncement('ESPERE O CAPITÃO ESCOLHER UMA SELEÇÃO...', playerId, 'INSTRUCTION');
                }
            }

            configuringTeamIndex++;

            for (let i = configuringTeamIndex + 1; i < teams.length; i++) {
                for (const playerId of teams[i].players) {
                    sendAnnouncement(`POSIÇÃO ${i - configuringTeamIndex} NA FILA PARA ESCOLHA DA SELEÇÃO`, playerId, 'INFORMATION');
                }
            }

            cancelEvent = new CancelEvent();
            await sleep(TEAM_CONFIG_TIME, cancelEvent);

            if (team.metadata.name === 'DEFAULT') {
                for (const playerId of team.players) {
                    sendAnnouncement('NENHUMA SELEÇÃO FOI ESCOLHIDA, UMA SERÁ ESCOLHIDA AUTOMATICAMENTE...', playerId, 'INFORMATION');
                }

                const randomTeam = getRandomTeam();
                team.metadata.name = randomTeam;
                selected_teams.add(randomTeam.toLowerCase());
            }

            const teamName = getTeamName(team);
            for (let i = 0; i < teams.length; i++) {
                const text = i === configuringTeamIndex
                    ? `SUA SELEÇÃO É ${teamName}! RUMO AO TÍTULO!`
                    : `${teamName} ENTROU NO CAMPEONATO! FIQUE ESPERTO!`;

                for (const playerId of teams[i].players) {
                    sendAnnouncement(text, playerId);
                }
            }

            const remainingTeams = teams.length - configuringTeamIndex - 1;
            if (remainingTeams > 0) {
                const message = i18n.t('teamsToConfigure', { count: remainingTeams });
                for (const playerId of team.players) {
                    sendAnnouncement(message, playerId, 'INFORMATION');
                }
            }
        }

        matches.length = 0;
        for (let i = 0; i < STARTING_MATCHES_COUNT; i++) {
            matches.push([ teams[i * 2], teams[i * 2 + 1] ]);
        }

        startMatch();
    };

    const reset = () => {
        gameInProgress = false;
        teams.length = 0;
        team_by_player.clear();
        has_voted.clear();
        currentMatchIndex = -1;
        matches.length = 0;
        selected_teams.clear();

        room.sendAnnouncement('[SERVIDOR] REINÍCIO DEFINITIVO');

        room.stopGame();
        clearAllTeams();
    };

    room.onPlayerJoin = ({ id: playerId }) => {
        players[0].push(playerId);
        update();

        if (getPlayerCount() === 1) room.setPlayerAdmin(playerId, true);
    };

    room.onPlayerLeave = (playerObject) => {
        changePlayerTeam(playerObject.id);
        update();
    };

    const kickArray = [];
    room.onPlayerBallKick = (playerObject) => {
        kickArray.unshift({ id: playerObject.id, name: playerObject.name });
        if (kickArray.length > 2) {
            kickArray.pop();
        }
    };

    room.onTeamGoal = (teamId) => {
        const [ goalScorer, assister ] = kickArray;
        const [ teamScorer, teamAssister ] = kickArray.map(({ id }) => team_by_player.get(id));

        const favoredTeam = matches[currentMatchIndex][teamId - 1];
        const kitColor = getPrimaryKitColor(favoredTeam.metadata.name);

        if (favoredTeam == teamScorer) {
            // pro goal

            const goalMessage = `GOL DE ${goalScorer.name} PARA ${getTeamName(favoredTeam)}!`;
            const assistMessage = goalScorer.id !== assister.id && teamScorer === teamAssister
                ? `\nASSISTÊNCIA DE ${assister.name}!`
                : '';

            sendAnnouncement(goalMessage + assistMessage, null, 'DEFAULT', kitColor);
        } else {
            // own goal
            sendAnnouncement(`GOL CONTRA DE ${goalScorer.name}! MELHOR PARA ${getTeamName(favoredTeam)}`, null, 'DEFAULT', kitColor);
        }
    };

    room.onTeamVictory = stopMatch;

    const baseCommandError = (err, playerId) => sendAnnouncement(`[ERRO] <${err}>`, playerId, 'ERROR');

    const loadMap = async (playerId, path, setError) => {
        try {
            const mapData = await readFile(path, 'utf-8');
            room.setCustomStadium(mapData);
        } catch (error) {
            baseCommandError(setError(error), playerId);
        }
    };

    const parseCommand = ({ id: playerId, name: playerName, admin }, message) => {
        if (!message.startsWith('!')) return null;

        const parts = message.slice(1).trim().split(/\s+/);

        const command = parts.shift().toLowerCase();
        const args = parts;

        if (ADMIN_COMMANDS.has(command) && !admin) return 'Comando restrito a administradores';

        if (command == COMMANDS.VOTE_CAPTAIN) {
            if (!canVoteForCaptain()) return 'Não é possível votar em um capitão';

            const team = team_by_player.get(playerId);
            if (!team) return 'Você não faz parte de um time no momento';

            if (has_voted.has(playerId)) return 'Você já votou em um capitão';

            if (args.length === 0) return 'Id não foi fornecido';

            const index = Number(args[0]) - 1;
            if (index < 0 || index >= team.players.length) return 'Id fora dos limites da lista de jogadores do time';

            team.metadata.captainVotes[index]++;
            has_voted.add(playerId);
            cancelEvent.emit();

            const targetPlayerName = room.getPlayer(team.players[index]).name; 
            const remainingVotesNeeded = cancelEvent.threshold; 

            if (remainingVotesNeeded > 0) { 
                // "notificationText" or "statusMessage" is clearer than "text2"
                const remainingVotesMessage = i18n.t('playersToVote', { count: remainingVotesNeeded }); 

                for (const teamPlayerIds of players) { 
                    for (const currentId of teamPlayerIds) {
                        const votingConfirmation = playerId === currentId 
                            ? `VOCẼ VOTOU EM ${playerId !== team.players[index] ? targetPlayerName : 'VOCẼ'} PARA CAPITÃO. ` 
                            : ''; 

                        sendAnnouncement(votingConfirmation + remainingVotesMessage, currentId, 'INFORMATION'); 
                    } 
                } 
            }
        }
        else if (command == COMMANDS.SELECT_TEAM) {
            const team = team_by_player.get(playerId);
            if (!team) return 'Você não faz parte de um time no momento';

            if (teams.indexOf(team) !== configuringTeamIndex) return 'Não é o seu momento de escolher uma seleção';

            if (playerId !== team.captain) return 'Você não é o capitão do time';

            if (team.metadata.name !== 'DEFAULT') return 'Você já escolheu uma seleção';

            if (args.length === 0) return 'Nenhum nome foi fornecido';

            const teamName = formatTeamName(kitNameArray, args.join(' '));

            if (!teamName) return 'Esse time não está na lista. Por favor, escolha outro';
            if (selected_teams.has(teamName.toLowerCase())) return 'Esse time já foi escolhido. Por favor, escolha outro';

            team.metadata.name = teamName;
            selected_teams.add(teamName.toLowerCase());
            cancelEvent.emit();
        }
        else if (command == COMMANDS.DEFINITIVE_RESET) {
            reset();
            update('RECOMEÇANDO, ESTÁ PREPARADO?')
        }
        else if (command == COMMANDS.CONFIGURE) {
            if (args.length === 0) return 'Nenhum argumento foi fornecido';

            for (const arg of args) {
                const index = arg.indexOf('=');
                if (!index) continue;

                const name = arg.substring(0, index);
                const value = arg.substring(index + 1);

                const setError = (err) => `Argumento: ${name} | ${err}`;

                if (name == 'map') {
                    const parsedPath = './' + value.replace(/^["']|["']$/g, '') + '.hbs';
                    loadMap(playerId, parsedPath, setError);
                }
                else if (name == 'score-limit') {
                    const num = Number(value);
                    if (Number.isNaN(num)) return setError('Argumento não é um número');

                    if (num < 1) return setError('Argumento precisa ser maior ou igual a 1');

                    room.setScoreLimit(num);
                }
                else if (name == 'time-limit') {
                    const num = Number(value);
                    if (Number.isNaN(num)) return setError('Argumento não é um número');

                    if (num < 1) return setError('Argumento precisa ser maior ou igual a 1');

                    room.setTimeLimit(num);
                }
                else return setError('Argumento não reconhecido');
            }
        }
        else if (command == COMMANDS.ROUND_LOG) {
            sendAnnouncement(getRoundLog(), playerId, 'INFORMATION');
        }
        else return `Comando não reconhecido (${command})`

        return true;
    };

    parseCommand({ admin: true }, baseConfigurationCommand);

    room.onPlayerChat = (playerObject, message) => {
        const result = parseCommand(playerObject, message);
        if (result) {
            if (result !== true) baseCommandError(result, playerObject.id);
            return false;
        }

        const playerTeam = team_by_player.get(playerObject.id);
        const teamStatusMessage = playerTeam && playerTeam.lost ? '[ELIMINADO] ' : '';
        const captainMessage = playerTeam && playerObject.id === playerTeam.captain ? '[C]' : '';

        let customColor;
        if (playerTeam) {
            customColor = getPrimaryKitColor(playerTeam.metadata.name);
        }

        sendAnnouncement(`${teamStatusMessage}${captainMessage} ${playerObject.name}: ${message}`, null, 'DEFAULT', customColor);

        return false;
    };
});