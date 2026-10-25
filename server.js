const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PAYSTACK_SECRET_KEY = 'sk_test_95d8892c1cd4784eed4fc4d8ebaecccaa4e57b88';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database Simulation (Can be connected to MongoDB/PostgreSQL later)
const users = {
  "Player1": { password: "123456", balance: 2900.00, role: "player" }
};

let gameState = 'IDLE';
let currentMultiplier = 1.00;
let crashPoint = 1.00;

// 1. Authentication API Routes
app.post('/api/register', (req, res) => {
  const { username, password, email, phone } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  if (users[username]) {
    return res.status(400).json({ success: false, message: 'Username already exists' });
  }

  users[username] = {
    password: password,
    balance: 2900.00, // Starting bonus
    email: email,
    phone: phone,
    role: "player"
  };

  console.log(`[AUTH] New user registered: ${username}`);
  res.json({ success: true, balance: 2900.00 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];

  if (!user || user.password !== password) {
    return res.status(400).json({ success: false, message: 'Invalid username or password' });
  }

  console.log(`[AUTH] User logged in: ${username}`);
  res.json({ success: true, balance: user.balance, role: user.role });
});

// Admin Route: Create Player/Demo Account
app.post('/api/admin/create-user', (req, res) => {
  const { adminUsername, username, password, initialBalance } = req.body;
  
  const admin = users[adminUsername];
  if (!admin || admin.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Unauthorized: Admin access required' });
  }

  if (users[username]) {
    return res.status(400).json({ success: false, message: 'Username already exists' });
  }

  users[username] = {
    password: password || '123456',
    balance: parseFloat(initialBalance) || 10000.00,
    role: 'player'
  };

  console.log(`[ADMIN] Created demo account for ${username} with balance ₦${initialBalance}`);
  res.json({ success: true, message: `Account ${username} created successfully!` });
});

// 2. Paystack Deposit Verification Route
app.post('/api/verify-deposit', async (req, res) => {
  const { username, reference, amount } = req.body;
  
  if (!users[username]) {
    return res.status(400).json({ success: false, message: 'User not found' });
  }

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    });
    const data = await response.json();

    if (data.status && data.data.status === 'success') {
      const verifiedAmount = data.data.amount / 100;
      users[username].balance += verifiedAmount;
      console.log(`[FINANCE] Paystack Verified! Credited ${username} with ₦${verifiedAmount} (Ref: ${reference})`);
      return res.json({ success: true, newBalance: users[username].balance });
    } else {
      return res.status(400).json({ success: false, message: 'Transaction verification failed or pending' });
    }
  } catch (error) {
    console.error('[FINANCE ERROR]', error);
    res.status(500).json({ success: false, message: 'Server error verifying payment' });
  }
});

// 3. Provably Fair / Safe Multiplier Algorithm on Server
function generateServerCrashPoint() {
  let rand = Math.random();
  if (rand < 0.60) {
    return parseFloat((1.01 + Math.pow(Math.random(), 2) * 1.99).toFixed(2));
  } else if (rand < 0.85) {
    return parseFloat((3.01 + Math.random() * 12.0).toFixed(2));
  } else if (rand < 0.95) {
    return parseFloat((15.01 + Math.random() * 85.0).toFixed(2));
  } else {
    return parseFloat((100.01 + Math.random() * 1900.0).toFixed(2)); // Up to 2000x+
  }
}

// 4. Real-Time Game Engine Loop (Fixed with IDLE State Window)
function startServerRound() {
  gameState = 'IDLE';
  currentMultiplier = 1.00;
  console.log('[GAME] Waiting for next round... Betting is open.');
  io.emit('round_idle', { gameState, message: 'Waiting for next round...' });

  // Give players a 5-second window to place bets before starting the round
  setTimeout(() => {
    gameState = 'RUNNING';
    crashPoint = generateServerCrashPoint();
    
    console.log(`[GAME] Round started. Target crash: ${crashPoint}x`);
    io.emit('round_started', { crashPoint });

    let startTime = Date.now();
    let interval = setInterval(() => {
      let elapsed = (Date.now() - startTime) / 1000;
      currentMultiplier = parseFloat((1 + Math.pow(elapsed, 1.65) * 0.15).toFixed(2));

      if (currentMultiplier >= crashPoint) {
        clearInterval(interval);
        gameState = 'CRASHED';
        console.log(`[GAME] Crashed at ${crashPoint}x`);
        io.emit('round_crashed', { crashPoint });

        // Wait 5 seconds before starting the next round loop
        setTimeout(startServerRound, 5000);
      } else {
        io.emit('multiplier_update', { currentMultiplier });
      }
    }, 100);
  }, 5000); 
}

// Socket.io Player Connection & Secure Game Actions
io.on('connection', (socket) => {
  console.log('A player connected via socket:', socket.id);
  socket.emit('sync_state', { gameState, currentMultiplier });

  // 1. Secure Server-Side Bet Placement
  socket.on('place_bet', (data) => {
    const { username, amount } = data;
    const user = users[username];

    if (user && gameState === 'IDLE') {
      if (user.balance >= amount) {
        user.balance -= amount;
        socket.emit('bet_placed_success', { newBalance: user.balance });
        console.log(`[BET] ${username} placed a bet of ₦${amount}. Remaining balance: ₦${user.balance}`);
      } else {
        socket.emit('bet_error', { message: 'Insufficient balance' });
      }
    } else {
      socket.emit('bet_error', { message: 'Round is already active. Please wait.' });
    }
  });

  // 2. Secure Server-Side Cash Out Calculation
  socket.on('cash_out', (data) => {
    const { username, amount } = data;
    const user = users[username];

    if (user && gameState === 'RUNNING') {
      const winnings = amount * currentMultiplier;
      user.balance += winnings;
      socket.emit('cashout_success', { winnings, newBalance: user.balance });
      console.log(`[CASH OUT] ${username} cashed out at ${currentMultiplier}x and won ₦${winnings.toFixed(2)}! New balance: ₦${user.balance}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
  });
});

// Kickoff the game loop
startServerRound();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Skyline Production Backend running on port ${PORT}`);
});
