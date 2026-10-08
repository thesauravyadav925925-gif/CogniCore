const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config/env');

async function hashPassword(plain) {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user, jti = null) {
  return jwt.sign(
    { sub: user.user_id, email: user.email, role: user.role, ...(jti ? { jti } : {}) },
    config.auth.jwtSecret,
    { expiresIn: config.auth.jwtExpiry }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.auth.jwtSecret); // throws on invalid/expired
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
