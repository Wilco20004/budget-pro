import express from 'express';
import path from 'path';
import fs from 'fs';
import './db';
import { requireAuth } from './auth';
import { publishSensors } from './ha';
import { startEmailWatcher } from './email/importer';
import { startInboxWatcher } from './inbox';
import { mcpRouter } from './mcp';
import { backupRouter } from './routes/backup';
import { emailRouter } from './routes/email';
import { whatsappRouter } from './routes/whatsapp';
import { whatsappWebhook } from './whatsapp';
import { budgetsRouter, kpisRouter } from './routes/budgets';
import { importsRouter } from './routes/imports';
import { notificationsRouter } from './routes/notifications';
import { paymentPlansRouter } from './routes/paymentPlans';
import { productsRouter, receiptsRouter } from './routes/receipts';
import {
  accountsRouter,
  categoriesRouter,
  groupsRouter,
  keywordsRouter,
  merchantsRouter,
  periodsRouter,
  settingsRouter,
} from './routes/setup';
import { transactionsRouter } from './routes/transactions';

const app = express();
const PORT = Number(process.env.PORT) || 8097;

app.use(express.json({ limit: '2mb' }));

// WhatsApp platform callbacks: checked by their own X-Api-Key, not the API
// token, so the platform never holds the key to the whole API.
app.post('/webhooks/whatsapp/:endpoint', whatsappWebhook);

// Unauthenticated on purpose: container health checks.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api', requireAuth);
app.use('/mcp', requireAuth);

app.use('/api/settings', settingsRouter);
app.use('/api/periods', periodsRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/keywords', keywordsRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/merchants', merchantsRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/payment-plans', paymentPlansRouter);
app.use('/api/kpis', kpisRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/imports', importsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/products', productsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/backup', backupRouter);
app.use('/api/email', emailRouter);
app.use('/api/whatsapp', whatsappRouter);
app.use('/mcp', mcpRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  // index.html must never be cached — after an add-on update it names the
  // new hashed bundle; the hashed assets themselves can be cached for good.
  app.use(
    express.static(webDist, {
      setHeaders: (res, file) => {
        res.setHeader('Cache-Control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
      },
    })
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/mcp')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`BudgetPro server listening on port ${PORT}`);
  startInboxWatcher();
  startEmailWatcher();
  publishSensors().catch(() => undefined);
  setInterval(() => publishSensors().catch(() => undefined), 5 * 60_000);
});
