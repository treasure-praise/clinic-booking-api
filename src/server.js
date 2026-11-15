const { createPool, migrate } = require('./db');
const { createApp } = require('./app');

async function start() {
  if (!process.env.API_KEY) {
    throw new Error('API_KEY is not set');
  }
  const pool = createPool();
  await migrate(pool);
  const app = createApp({ pool, apiKey: process.env.API_KEY });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`Clinic booking API listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
