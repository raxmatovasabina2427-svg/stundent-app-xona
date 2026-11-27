// Bildirishnomalar outbox'i (T-10). Xabar tranzaksiya ichida yoziladi;
// Telegram ishchisi (Faza 5) keyin yuboradi. Telegram ishlamasa ham bron saqlanadi.
async function notify(client, userId, matn) {
  await client.query('INSERT INTO bildirishnomalar (user_id, matn) VALUES ($1, $2)', [userId, matn]);
}

module.exports = { notify };
