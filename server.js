const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// Автоматический выбор: облачная база Render или локальная PostgreSQL
const pool = new Pool(
    process.env.DATABASE_URL
        ? {
              connectionString: process.env.DATABASE_URL,
              ssl: { rejectUnauthorized: false } // Обязательно для внешнего подключения к Render DB
          }
        : {
              user: 'postgres',
              host: 'localhost',
              database: 'coffeelake_db',
              password: 'ICTP',
              port: 5432,
          }
);

// Порт для Render или локальной машины
const PORT = process.env.PORT || 5000;

// ... дальше идут ваши роуты (/api/menu, /api/orders и т.д.) ...
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let user;
        if (result.rows.length === 0) {
            // Автоматическая регистрация для удобства тестирования
            const insertRes = await pool.query(
                'INSERT INTO users (email, password, loyalty_counter) VALUES ($1, $2, 0) RETURNING *',
                [email, password]
            );
            user = insertRes.rows[0];
        } else {
            user = result.rows[0];
            if (user.password !== password) {
                return res.status(401).json({ success: false, error: 'Неверный пароль' });
            }
        }
        res.json({ success: true, user });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ЗАГРУЗКА МЕНЮ С ПОИСКОМ
app.get('/api/menu', async (req, res) => {
    const { search } = req.query;
    try {
        let queryText = `
            SELECT m.item_id, m.name, m.volume_ml, m.price_kzt, c.category_name 
            FROM menu_items m
            JOIN categories c ON m.category_id = c.category_id
            WHERE m.is_available = TRUE
        `;
        const queryParams = [];

        if (search && search.trim() !== '') {
            queryText += ` AND (m.name ILIKE $1 OR c.category_name ILIKE $1)`;
            queryParams.push(`%${search.trim()}%`);
        }

        queryText += ` ORDER BY c.category_id ASC, m.item_id ASC;`;
        const result = await pool.query(queryText, queryParams);
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ОФОРМЛЕНИЕ ЗАКАЗА
app.post('/api/orders', async (req, res) => {
    const { userId, items, totalPrice } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const orderRes = await client.query(`
            INSERT INTO orders (user_id, pickup_time, total_price, order_status)
            VALUES ($1, NOW() + INTERVAL '15 minutes', $2, 'Paid & Preparing')
            RETURNING order_id;
        `, [userId, totalPrice]);

        const newOrderId = orderRes.rows[0].order_id;

        for (const item of items) {
            await client.query(`
                INSERT INTO order_items (order_id, item_id, quantity, unit_price, customization_notes)
                VALUES ($1, $2, $3, $4, $5);
            `, [newOrderId, item.itemId, item.quantity || 1, item.price, 'extra sugar']);
        }

        await client.query(`
            UPDATE users SET loyalty_counter = loyalty_counter + 1 WHERE user_id = $1;
        `, [userId]);

        await client.query('COMMIT');
        res.json({ success: true, orderId: newOrderId });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server is running locally on http://localhost:${PORT}`);
});
