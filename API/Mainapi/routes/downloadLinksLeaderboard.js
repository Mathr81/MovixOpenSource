const express = require('express');
const router = express.Router();
const { getPool } = require('../mysqlPool');
const { isUploaderOrAdmin } = require('../middleware/auth');
const { resolveAdminIdentity } = require('../utils/adminIdentity');

router.get('/admin/leaderboard', isUploaderOrAdmin, async (req, res) => {
  try {
    const scope = req.query.scope === 'all-time' ? 'all-time' : 'month';
    const pool = getPool();

    let whereClause = '';
    let params = [];
    let periodLabel = null;

    if (scope === 'month') {
      const monthParam = Array.isArray(req.query.month) ? req.query.month[0] : req.query.month;
      const monthMatch = typeof monthParam === 'string' && monthParam.trim()
        ? monthParam.trim().match(/^(\d{4})-(\d{2})$/)
        : null;
      if (monthParam && (!monthMatch || Number(monthMatch[2]) < 1 || Number(monthMatch[2]) > 12)) {
        return res.status(400).json({ error: 'Invalid month format. Expected YYYY-MM' });
      }
      const target = monthMatch
        ? new Date(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1)
        : new Date();
      const start = new Date(target.getFullYear(), target.getMonth(), 1);
      const end = new Date(target.getFullYear(), target.getMonth() + 1, 1);
      const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      whereClause = 'WHERE changed_at >= ? AND changed_at < ?';
      params = [fmt(start), fmt(end)];
      periodLabel = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
    }

    const [rows] = await pool.execute(
      `SELECT
         admin_id,
         admin_auth_type,
         SUM(CASE WHEN action = 'added' THEN 1 ELSE -1 END) AS score,
         MAX(changed_at) AS last_action_at
       FROM download_links_history
       ${whereClause}
       GROUP BY admin_id, admin_auth_type
       HAVING score > 0
       ORDER BY score DESC, last_action_at DESC`,
      params
    );

    const adminIds = rows.map(r => r.admin_id);
    const adminRoles = {};
    if (adminIds.length > 0) {
      const placeholders = adminIds.map(() => '?').join(',');
      const [roleRows] = await pool.execute(
        `SELECT user_id, role FROM admins WHERE user_id IN (${placeholders})`,
        adminIds
      );
      for (const r of roleRows) {
        adminRoles[r.user_id] = r.role || 'admin';
      }
    }

    const leaderboard = await Promise.all(rows.map(async (row) => {
      const identity = await resolveAdminIdentity(row.admin_id, row.admin_auth_type);
      return {
        admin_id: row.admin_id,
        admin_auth_type: row.admin_auth_type,
        role: adminRoles[row.admin_id] || 'admin',
        username: identity.username,
        avatar: identity.avatar,
        score: Number(row.score),
        last_action_at: row.last_action_at,
      };
    }));

    const responseBody = { leaderboard };
    if (scope === 'month') responseBody.month = periodLabel;
    else responseBody.scope = 'all-time';
    res.json(responseBody);
  } catch (error) {
    console.error('Error fetching download leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch download leaderboard' });
  }
});

module.exports = router;
