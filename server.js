const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname,'public')));

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required'); process.exit(1);
}
if (!process.env.ADMIN_PASSWORD || !process.env.JWT_SECRET) {
  console.error('Set ADMIN_PASSWORD and JWT_SECRET in environment variables'); process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});
const statuses = ['Nouvelle','Confirmée','En préparation','Expédiée','Livrée','Annulée'];
async function init(){
  await pool.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
}
function auth(req,res,next){
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/,'');
  try { jwt.verify(token,process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Connexion admin requise'}); }
}
app.get('/api/health',(req,res)=>res.json({ok:true,app:"D'ORÉA BEAUTY"}));
app.get('/api/products',async(req,res)=>{
  try { const r=await pool.query('SELECT id,name,category,description,price,stock,image_url FROM products WHERE active=true ORDER BY created_at DESC');
    res.json(r.rows); } catch(e){console.error(e);res.status(500).json({error:'Erreur serveur'});}
});
app.post('/api/admin/login',async(req,res)=>{
  const password=String(req.body.password||'');
  if(password.length<1 || password!==process.env.ADMIN_PASSWORD) return res.status(401).json({error:'Mot de passe incorrect'});
  const token=jwt.sign({role:'admin'},process.env.JWT_SECRET,{expiresIn:'12h'});
  res.json({token});
});
app.post('/api/admin/products',auth,async(req,res)=>{
  const {name,category,description,price,stock,image_url}=req.body;
  if(!name || !Number.isFinite(Number(price)) || Number(price)<0) return res.status(400).json({error:'Nom et prix valides requis'});
  try{
    const r=await pool.query(`INSERT INTO products(name,category,description,price,stock,image_url)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name,category||'Maquillage',description||'',Number(price),Math.max(0,parseInt(stock)||0),image_url||'']);
    res.status(201).json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Impossible d’ajouter le produit'});}
});
app.put('/api/admin/products/:id',auth,async(req,res)=>{
  const {name,category,description,price,stock,image_url}=req.body;
  try{
    const r=await pool.query(`UPDATE products SET name=$1,category=$2,description=$3,price=$4,stock=$5,image_url=$6
      WHERE id=$7 AND active=true RETURNING *`,
      [name,category||'Maquillage',description||'',Number(price),Math.max(0,parseInt(stock)||0),image_url||'',req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'Produit introuvable'});
    res.json(r.rows[0]);
  }catch(e){console.error(e);res.status(500).json({error:'Modification impossible'});}
});
app.delete('/api/admin/products/:id',auth,async(req,res)=>{
  try{const r=await pool.query('UPDATE products SET active=false WHERE id=$1 RETURNING id',[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'Produit introuvable'});res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:'Suppression impossible'});}
});
app.post('/api/orders',async(req,res)=>{
  const {customer_name,phone,address,items}=req.body;
  if(!customer_name||!phone||!address||!Array.isArray(items)||!items.length) return res.status(400).json({error:'Informations de commande incomplètes'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    let total=0, normalized=[];
    for(const item of items){
      const id=Number(item.product_id), qty=Math.max(1,parseInt(item.quantity)||1);
      const p=await client.query('SELECT id,name,price,stock FROM products WHERE id=$1 AND active=true FOR UPDATE',[id]);
      if(!p.rowCount) throw new Error('Un produit n’est plus disponible.');
      const product=p.rows[0];
      if(product.stock<qty) throw new Error(`Stock insuffisant pour ${product.name}.`);
      await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2',[qty,id]);
      const line=Number(product.price)*qty; total+=line;
      normalized.push({product_id:id,name:product.name,quantity:qty,unit_price:Number(product.price),line_total:line});
    }
    const result=await client.query(`INSERT INTO orders(customer_name,phone,address,items,total)
      VALUES($1,$2,$3,$4,$5) RETURNING id`,[customer_name,phone,address,JSON.stringify(normalized),total]);
    await client.query('COMMIT');
    res.status(201).json({ok:true,order_id:result.rows[0].id,total});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}
  finally{client.release();}
});
app.get('/api/admin/orders',auth,async(req,res)=>{
  try{const r=await pool.query('SELECT * FROM orders ORDER BY created_at DESC');res.json(r.rows);}
  catch(e){console.error(e);res.status(500).json({error:'Erreur serveur'});}
});
app.patch('/api/admin/orders/:id',auth,async(req,res)=>{
  const status=req.body.status;
  if(!statuses.includes(status))return res.status(400).json({error:'Statut invalide'});
  try{const r=await pool.query('UPDATE orders SET status=$1 WHERE id=$2 RETURNING *',[status,req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:'Commande introuvable'});res.json(r.rows[0]);}
  catch(e){console.error(e);res.status(500).json({error:'Erreur serveur'});}
});
app.delete('/api/admin/orders/:id',auth,async(req,res)=>{
  try{await pool.query('DELETE FROM orders WHERE id=$1',[req.params.id]);res.json({ok:true});}
  catch(e){console.error(e);res.status(500).json({error:'Suppression impossible'});}
});
const port=process.env.PORT||3000;
init().then(()=>app.listen(port,()=>console.log(`D'ORÉA BEAUTY running on ${port}`)))
.catch(e=>{console.error('Database initialization failed',e);process.exit(1);});
