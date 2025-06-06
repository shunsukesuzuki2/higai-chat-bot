const sqlite3 = require('sqlite3').verbose();

// DBファイル（存在しなければ作成）
const db = new sqlite3.Database('./reports.db');

// damagereport テーブルを作成
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS damagereport (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT,
      latitude REAL,
      longitude REAL,
      imageUrl TEXT,
      severity TEXT,
      userId TEXT
    )
  `);
  console.log('📁 damagereport テーブルが作成されました');
});

db.close();
