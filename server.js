const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.sendStatus(200);
  next();
});

const API_KEY = process.env.E2PAYMENTS_KEY || 'demo';
const SECRET = process.env.WEBHOOK_SECRET || 'segredo';
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicializar DB
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS wallets (user_id TEXT PRIMARY KEY, phone TEXT, balance NUMERIC DEFAULT 0, xp INTEGER DEFAULT 0, kyc_status TEXT DEFAULT 'pendente')`);
    await pool.query(`CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY, user_id TEXT, type TEXT, method TEXT, amount NUMERIC, phone TEXT, reference TEXT UNIQUE, status TEXT, created_at TIMESTAMP DEFAULT NOW())`);
    console.log('DB pronto');
  } catch(e){ console.log('DB erro:', e.message); }
})();

// Servir arquivos estáticos do node_modules para analytics
app.use('/@vercel', express.static(__dirname + '/node_modules/@vercel'));

// Frontend servido diretamente
app.get('/', (req,res)=>{
  res.sendFile(__dirname + '/index.html');
});

// API Deposit
app.post('/api/deposit', async (req,res)=>{
  const { user_id, amount, phone, method } = req.body;
  if(!amount || amount < 10) return res.status(400).json({error:'Mínimo 10 MZN'});
  const ref = `INV-${Date.now()}`;
  try {
    await pool.query('INSERT INTO transactions (user_id,type,method,amount,phone,reference,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',[user_id,'deposito',method,amount,phone,ref,'pendente']);
    // Chamada real e2Payments
    if(API_KEY !== 'demo'){
      const url = method==='mpesa' ? 'https://e2payments.explicador.co.mz/v1/c2b/mpesa' : 'https://e2payments.explicador.co.mz/v1/c2b/emola';
      await fetch(url,{method:'POST',headers:{'Authorization':`Bearer ${API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({amount,phone,reference:ref,callback_url:`${process.env.BASE_URL}/webhook/e2payments`})});
    }
    res.json({success:true, reference:ref, demo: API_KEY==='demo'});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Webhook
app.post('/webhook/e2payments', async (req,res)=>{
  const {reference,status,amount} = req.body;
  if(status==='success'){
    await pool.query('UPDATE transactions SET status=$1 WHERE reference=$2',['concluido',reference]);
    const tx = await pool.query('SELECT user_id,phone FROM transactions WHERE reference=$1',[reference]);
    if(tx.rows[0]){
      const {user_id,phone}=tx.rows[0];
      await pool.query('INSERT INTO wallets (user_id,phone,balance,xp) VALUES ($1,$2,$3,10) ON CONFLICT (user_id) DO UPDATE SET balance = wallets.balance + $3, xp = wallets.xp + 10',[user_id,phone,amount]);
    }
  }
  res.sendStatus(200);
});

// Saldo
app.get('/api/wallet/:id', async (req,res)=>{
  try {
    const r = await pool.query('SELECT balance,xp,kyc_status FROM wallets WHERE user_id=$1',[req.params.id]);
    res.json(r.rows[0] || {balance:0,xp:0,kyc_status:'pendente'});
  } catch(e){ res.json({balance:0,xp:0}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('InvestMZ rodando na porta', PORT));
