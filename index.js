const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./reports.db');
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const app = express();
const client = new line.Client(config);
const userStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhookエラー:', err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'message') 
  {
    const msg = event.message;

    // 「報告」開始 → ユーザー登録 & 位置情報要求
    if (msg.type === 'text' && msg.text.trim() === '報告') {
      userStates[userId] = 'waitingForLocation';

      // DBに新規登録（userIdのみ）
      db.run(
        `INSERT INTO damagereport (userId) VALUES (?)`,
        [userId],
        function (err) {
          if (err) {
            console.error('❌ ユーザー登録エラー:', err.message);
          } else {
            console.log(`✅ 新しい報告を作成（ID: ${this.lastID}）`);
          }
        }
      );

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害の位置情報を送ってください'
      });
      
    }
  // 「一覧」入力 
  // 「一覧」入力 → 件数確認メッセージ & 状態設定
    if (msg.type === 'text' && msg.text.trim() === '一覧') 
    {
      userStates[userId] = 'waitingForListCount';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '何件表示しますか？数字を入力するか、全件表示する場合は「all」と入力してください。'
      });
    }

    // 件数 or all を受け取って一覧表示
if (msg.type === 'text' && userStates[userId] === 'waitingForListCount') 
  {
    const input = msg.text.trim().toLowerCase();
    let limitQuery = '';
    let responsePrefix = '';

    if (input === 'all') 
    {
      limitQuery = ''; // no LIMIT
      responsePrefix = '📋 被害報告一覧（全件）\n\n';
    } 
    else if (/^\d+$/.test(input))
    {
      limitQuery = `LIMIT ${parseInt(input, 10)}`;
      responsePrefix = `📋 被害報告一覧（最新${input}件）\n\n`;
    } 
    else 
    {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '数字または「all」と入力してください。'
      });
    }

    userStates[userId] = 'done'; // 状態リセット

    return new Promise((resolve) => 
    {
      db.all
      (
        `SELECT address, latitude, longitude, severity, userId FROM damagereport ORDER BY id DESC ${limitQuery}`,
        [],
        (err, rows) => 
        {
          if (err) 
          {
            console.error('❌ 一覧取得エラー:', err.message);
            return client.replyMessage(event.replyToken, {
              type: 'text',
              text: '一覧の取得中にエラーが発生しました。'
            }).then(resolve);
          }

          if (rows.length === 0) {
            return client.replyMessage(event.replyToken, {
              type: 'text',
              text: '被害報告はまだ登録されていません。'
            }).then(resolve);
          }

          const messageText = rows.map((r, i) => {
            return `📍報告${i + 1}\n住所: ${r.address || '不明'}\n緯度: ${r.latitude}\n経度: ${r.longitude}\n被害: ${r.severity}\nユーザー: ${r.userId}`;
          }).join('\n\n');

          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: `${responsePrefix}${messageText}`
          }).then(resolve);
        }
      );
    });
  }




  

    

    // 位置情報受信 → DBに更新 & 写真要求
    if (msg.type === 'location' && userStates[userId] === 'waitingForLocation') {
      userStates[userId] = 'waitingForPhoto';
      db.run(
        `UPDATE damagereport SET address = ?, latitude = ?, longitude = ? WHERE userId = ? AND address IS NULL`,
        [msg.address, msg.latitude, msg.longitude, userId],
        function (err) {
          if (err) {
            console.error('❌ 位置情報保存エラー:', err.message);
          } else {
            console.log(`✅ 位置情報を更新（userId: ${userId}）`);
          }
        }
      );

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `位置情報を受け取りました（${msg.address}）。次に写真を共有してください。`
      });
    }

    // 写真受信 → DBに更新（画像URL仮保存） & 被害レベル要求
    if (msg.type === 'image' && userStates[userId] === 'waitingForPhoto') {
      userStates[userId] = 'waitingForSeverity';
      db.run(
        `UPDATE damagereport SET imageUrl = ? WHERE userId = ? AND imageUrl IS NULL`,
        [msg.id, userId], // 後で画像URL変換可
        function (err) {
          if (err) {
            console.error('❌ 画像保存エラー:', err.message);
          } else {
            console.log(`✅ 画像IDを保存（userId: ${userId}）`);
          }
        }
      );

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害状況のレベルを教えてください（軽微・中程度・重大）'
      });
    }

    // 被害レベル受信 → DBに保存 → 完了
    if (msg.type === 'text' && userStates[userId] === 'waitingForSeverity') {
      userStates[userId] = 'done';

      db.run(
        `UPDATE damagereport SET severity = ? WHERE userId = ? AND severity IS NULL`,
        [msg.text, userId],
        function (err) {
          if (err) {
            console.error('❌ 被害レベル保存エラー:', err.message);
          } else {
            console.log(`✅ 被害レベルを保存（userId: ${userId}）`);
          }
        }
      );

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ありがとうございます。「${msg.text}」として記録しました。ご協力ありがとうございました！`
      });
    }
  }

  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 LINE Bot is running on port ${port}`);
});

