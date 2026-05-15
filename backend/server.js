const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(cors());
app.use(express.json());

const SECRET_KEY = 'stick_farm_secret_key_2024';
const users = {};
const devices = {};
const messages = {};
const miningIntervals = {};

// ===== AUTHENTICATION =====

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Логін і пароль обов\'язкові' });
  }

  if (users[username]) {
    return res.status(400).json({ error: 'Користувач вже існує' });
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  
  users[username] = {
    password: hashedPassword,
    balance: 0,
    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
    friends: [],
    friendRequests: []
  };

  const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '7d' });
  res.json({ token, username });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Логін і пароль обов\'язкові' });
  }

  if (!users[username]) {
    return res.status(400).json({ error: 'Користувача не існує' });
  }

  const validPassword = await bcrypt.compare(password, users[username].password);
  
  if (!validPassword) {
    return res.status(400).json({ error: 'Неправильний пароль' });
  }

  const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: '7d' });
  res.json({ 
    token, 
    username,
    balance: users[username].balance,
    avatar: users[username].avatar,
    friends: users[username].friends
  });
});

// ===== SOCKET.IO =====

io.on('connection', (socket) => {
  console.log('Користувач підключився:', socket.id);

  socket.on('authenticate', (data) => {
    const token = data.token;
    const deviceName = data.deviceName || 'Device_' + socket.id.substr(0, 6);

    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;

      devices[socket.id] = {
        username,
        deviceName,
        socket: socket,
        mining: false,
        connected: true
      };

      socket.join(username);
      socket.emit('auth_success', { username });

      io.to(username).emit('device_list_update', getDevicesForUser(username));
      console.log(`✓ ${deviceName} підключився до акаунту ${username}`);

    } catch (err) {
      socket.emit('auth_error', { error: 'Невалідний токен' });
    }
  });

  // ===== МАЙНІНГ =====
  socket.on('start_mining', () => {
    const device = devices[socket.id];
    if (!device) return;

    device.mining = true;
    const username = device.username;
    const deviceId = socket.id;

    console.log(`⛏️ [MINING] ${device.deviceName} користувача ${username} почав майнити`);

    const mineInterval = setInterval(() => {
      if (!devices[deviceId] || !device.mining || !users[username]) {
        clearInterval(mineInterval);
        delete miningIntervals[deviceId];
        return;
      }

      users[username].balance += 0.0001;
      
      io.to(username).emit('balance_update', {
        balance: users[username].balance,
        device: device.deviceName,
        miningDevices: getActiveMiningDevices(username)
      });

    }, 1000);

    miningIntervals[deviceId] = mineInterval;
    device.mineInterval = mineInterval;
    io.to(username).emit('device_list_update', getDevicesForUser(username));
  });

  socket.on('stop_mining', () => {
    const device = devices[socket.id];
    if (!device) return;

    device.mining = false;
    const username = device.username;
    
    if (device.mineInterval) {
      clearInterval(device.mineInterval);
      delete miningIntervals[socket.id];
    }

    console.log(`⏹️ [MINING STOP] ${device.deviceName} користувача ${username} зупинив майнінг`);
    
    io.to(username).emit('device_list_update', getDevicesForUser(username));
  });

  // ===== ТРАНСФЕР =====
  socket.on('transfer_coins', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { recipient, amount } = data;
    const sender = device.username;

    if (!users[recipient]) {
      socket.emit('transfer_error', { error: 'Користувача не існує' });
      return;
    }

    if (users[sender].balance < amount) {
      socket.emit('transfer_error', { error: 'Недостатньо коштів' });
      return;
    }

    users[sender].balance -= amount;
    users[recipient].balance += amount;

    io.to(sender).emit('balance_update', { balance: users[sender].balance });
    io.to(recipient).emit('balance_update', { balance: users[recipient].balance });

    socket.emit('transfer_success', { amount, recipient });
  });

  // ===== ДРУЗІ =====
  socket.on('send_friend_request', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { friendName } = data;
    const username = device.username;

    if (!users[friendName]) {
      socket.emit('error', { error: 'Користувача не існує' });
      return;
    }

    if (!users[friendName].friendRequests) {
      users[friendName].friendRequests = [];
    }

    if (users[friendName].friendRequests.includes(username)) {
      socket.emit('error', { error: 'Запит уже відправлено' });
      return;
    }

    users[friendName].friendRequests.push(username);
    io.to(friendName).emit('friend_request_received', { from: username });
    socket.emit('success', { message: 'Запит відправлено' });
  });

  socket.on('accept_friend_request', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { friendName } = data;
    const username = device.username;

    if (!users[friendName].friendRequests.includes(username)) {
      return;
    }

    users[friendName].friendRequests = users[friendName].friendRequests.filter(r => r !== username);
    users[username].friends.push(friendName);
    users[friendName].friends.push(username);

    io.to(username).emit('friend_list_update', users[username].friends);
    io.to(friendName).emit('friend_list_update', users[friendName].friends);
  });

  // ===== ПРИВАТНІ ЧАТИ =====
  socket.on('send_private_message', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { to, message } = data;
    const from = device.username;

    const chatKey = [from, to].sort().join(':');
    if (!messages[chatKey]) {
      messages[chatKey] = [];
    }

    const msg = {
      from,
      text: message,
      timestamp: Date.now()
    };

    messages[chatKey].push(msg);
    io.to(from).emit('new_message', { from: to, ...msg });
    io.to(to).emit('new_message', { from, ...msg });
  });

  socket.on('get_chat_history', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { friendName } = data;
    const username = device.username;
    const chatKey = [username, friendName].sort().join(':');
    const history = messages[chatKey] || [];

    socket.emit('chat_history', { friendName, messages: history });
  });

  // ===== РУЛЕТКА =====
  socket.on('spin_wheel', (data) => {
    const device = devices[socket.id];
    if (!device) return;

    const { betAmount, color } = data;
    const username = device.username;

    if (users[username].balance < betAmount) {
      socket.emit('spin_error', { error: 'Недостатньо коштів' });
      return;
    }

    users[username].balance -= betAmount;

    setTimeout(() => {
      const result = Math.random();
      let winColor;

      if (result < 0.48) winColor = 'red';
      else if (result < 0.96) winColor = 'black';
      else winColor = 'green';

      let won = false;
      let winAmount = 0;

      if (winColor === color) {
        won = true;
        winAmount = betAmount * (color === 'green' ? 14 : 2);
        users[username].balance += winAmount;
      }

      io.to(username).emit('spin_result', {
        won,
        winAmount,
        resultColor: winColor,
        newBalance: users[username].balance
      });

    }, 5000);

    io.to(username).emit('balance_update', { balance: users[username].balance });
  });

  // ===== ВІДКЛЮЧЕННЯ =====
  socket.on('disconnect', () => {
    const device = devices[socket.id];
    if (device) {
      if (device.mining) {
        clearInterval(device.mineInterval);
        delete miningIntervals[socket.id];
      }
      const username = device.username;
      delete devices[socket.id];
      
      io.to(username).emit('device_list_update', getDevicesForUser(username));
      console.log(`❌ ${device.deviceName} користувача ${username} відключився`);
    }
  });
});

// ===== ДОПОМІЖНІ ФУНКЦІЇ =====

function getDevicesForUser(username) {
  return Object.values(devices)
    .filter(d => d.username === username)
    .map(d => ({
      name: d.deviceName,
      mining: d.mining,
      socketId: d.socket.id
    }));
}

function getActiveMiningDevices(username) {
  return Object.values(devices)
    .filter(d => d.username === username && d.mining)
    .length;
}

// ===== REST ENDPOINTS =====

app.get('/api/user/:username', (req, res) => {
  const { username } = req.params;
  
  if (!users[username]) {
    return res.status(404).json({ error: 'Користувача не знайдено' });
  }

  res.json({
    username,
    balance: users[username].balance,
    avatar: users[username].avatar,
    friends: users[username].friends
  });
});

app.get('/api/search-users/:query', (req, res) => {
  const { query } = req.params;
  const results = Object.keys(users)
    .filter(u => u.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 10)
    .map(u => ({
      username: u,
      avatar: users[u].avatar
    }));

  res.json(results);
});

app.post('/api/change-password', (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  
  if (!users[username]) {
    return res.status(404).json({ error: 'Користувача не знайдено' });
  }

  if (!bcrypt.compareSync(oldPassword, users[username].password)) {
    return res.status(400).json({ error: 'Неправильний пароль' });
  }

  users[username].password = bcrypt.hashSync(newPassword, 10);
  res.json({ success: true });
});

app.get('/api/stats', (req, res) => {
  res.json({
    totalUsers: Object.keys(users).length,
    onlineUsers: new Set(Object.values(devices).map(d => d.username)).size,
    activeDevices: Object.keys(devices).length,
    activeMining: Object.keys(miningIntervals).length
  });
});

// ===== ЗАПУСК СЕРВЕРА =====

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Сервер запущений на http://localhost:${PORT}`);
  console.log(`📡 WebSocket доступний на ws://localhost:${PORT}`);
});
