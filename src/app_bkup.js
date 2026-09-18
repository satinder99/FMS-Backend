// app-wiring-example.js — NOT a real entry point, just shows how the
// pieces above plug into your existing Express app.

const express = require('express');
const cookieParser = require('cookie-parser'); // needed to read the refresh-token cookie
const authRoutes = require('./authRoutes');
const { requireAuth } = require('./authMiddleware');
const errorHandler = require('./errorHandler');

const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
// -> POST /api/auth/signup
// -> POST /api/auth/signin
// -> POST /api/auth/refresh
// -> POST /api/auth/logout
// -> POST /api/auth/logout-all   (revoke everywhere — e.g. on termination)

// Everything else requires a valid short-lived access token:
app.use('/api/orders', requireAuth, /* ordersRouter */ (req, res) => res.send('orders route'));
app.use('/api/drivers', requireAuth, /* driversRouter */ (req, res) => res.send('drivers route'));

app.use(errorHandler); // must be registered LAST

module.exports = app;