const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const AWS = require('aws-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const app = express();
const client = new line.Client(config);


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const userStates = {};



const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});
//メニューボタンを表示する関数
function getMenuButtons() {
  return {
    type: 'template',
    altText: '操作を選択してください',
    template: {
      type: 'buttons',
      title: '次の操作を選んでください',
      text: '以下から操作を選択できます',
      actions: [
        { type: 'message', label: '報告', text: '報告' },
        { type: 'message', label: '被害地一覧', text: '被害地一覧' }
      ]
    }
  };
}

//AWSのS3ストレージに取得した画像を格納する関数
async function uploadImageFromLine(messageId, userid) {
  const imageStream = await client.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of imageStream) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  const key = `${userid}_${messageId}.jpg`;
  const result = await s3.upload({
    Bucket: process.env.S3_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg'
  }).promise();
  return result.Location;
}

// 管理者一覧を取得する関数
async function getAdminUserIds() {
  try {
    const result = await pool.query('SELECT user_id FROM admins');
    return result.rows.map(row => row.user_id);
  } catch (err) {
    console.error('❌ 管理者の取得に失敗:', err);
    return [];
  }
}

//1報告の報告とその被害写真を1配列にまとめる関数
function buildReportMessages(r, idx) {
  const address = r.address;
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  const textMsg = {
    type: 'text',
    text:
      `📍報告${idx + 1}\n` +
      `住所: ${r.address ?? '不明'}\n` +
      `google map: ${mapUrl ?? '不明'}\n` +
      `緯度: ${r.latitude}, 経度: ${r.longitude}\n` +
      `被害: ${r.severity}`
  };

  const imageMsg = {
    type: 'image',
    originalContentUrl: r.imageurl,
    previewImageUrl: r.imageurl
  };

  return [textMsg, imageMsg];
}

// size件ごとにレポートメッセージをまとめる関数
function chunkMessages(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}



// デバッグ：リクエスト受信ログ
app.post(
  '/webhook',
  line.middleware(config),
  async (req, res) => {
    console.log('📥 Received POST /webhook', JSON.stringify(req.body, null, 2));

    try {
      const results = await Promise.all(
        req.body.events.map(handleEvent)
      );
      console.log('🎉 All events handled:', results);
      return res.json(results);
    } catch (err) {
      console.error('🔥 Processing error:', err);
      return res.status(500).end();
    }
  }
);

async function handleEvent(event) {
  const userid = event.source.userId;
  //友達追加時の処理
  if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, getMenuButtons());
  }

  if (event.type === 'message') {
    const msg = event.message;
    // 被害地一覧機能
    if (msg.type === 'text' && msg.text.trim() === '被害地一覧') {
      userStates[userid] = 'waitingForListCount';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '何件表示しますか？数字を入力するか、全件表示する場合は「all」と入力してください。'
      });
    }

    if (msg.type === 'text' && userStates[userid] === 'waitingForListCount') {
      const input = msg.text.trim().toLowerCase();
      let limitClause = '';
      let responsePrefix = '';

      if (input === 'all') {
        responsePrefix = '📋 被害地一覧（全件）\n';
      } else if (/^\d+$/.test(input)) {
        limitClause = `LIMIT ${parseInt(input, 10)}`;
        responsePrefix = `📋 被害地一覧（最新${input}件）\n`;
      } else {
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '数字または「all」と入力してください。'
        });
      }

      userStates[userid] = 'done';

      try {
        const result = await pool.query(
          `SELECT address, latitude, longitude, severity, userid, imageurl FROM damagereport ORDER BY id DESC ${limitClause}`
        );

        if (result.rows.length === 0) {
          return client.replyMessage(event.replyToken, [
            { type: 'text', text: '被害報告はまだ登録されていません。' },
            getMenuButtons()
          ]);
        }
        // 配列化（buildReportMessages にDBのと index を渡す）
        const allMsgs = result.rows.flatMap((r, idx) => buildReportMessages(r, idx));
        // ヘッダーを追加
        const headerMsg = { type: 'text', text: responsePrefix };
        allMsgs.unshift(headerMsg);

        // チャンク化（5 件ずつ）
        const chunks = chunkMessages(allMsgs, 5);
        // 送信
        //最初のチャンクを返す
        await client.replyMessage(event.replyToken, chunks[0]);
        // 残りのチャンクは pushMessage で順次送信
        for (let i = 1; i < chunks.length; i++) {
          await client.pushMessage(userid, chunks[i]);
        }
        // メニューを表示
        await client.pushMessage(userid, getMenuButtons());
        return;
      } catch (err) {
        console.error('❌ 一覧取得エラー:', err.message);
        return client.replyMessage(event.replyToken, [
          { type: 'text', text: '一覧の取得中にエラーが発生しました。' },
          getMenuButtons()
        ]);
      }
    }

    // 報告機能
    if (msg.type === 'text' && msg.text.trim() === '報告') {
      userStates[userid] = 'waitingForLocation';
      await pool.query(`INSERT INTO damagereport (userid) VALUES ($1)`, [userid]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害の位置情報を送ってください'
      });
    }

    if (msg.type === 'location' && userStates[userid] === 'waitingForLocation') {
      userStates[userid] = 'waitingForPhoto';
      await pool.query(
        `UPDATE damagereport SET address = $1, latitude = $2, longitude = $3 WHERE userid = $4 AND address IS NULL`,
        [msg.address, msg.latitude, msg.longitude, userid]
      );
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `位置情報を受け取りました（${msg.address}）。次に写真を共有してください。`
      });
    }

    if (msg.type === 'image' && userStates[userid] === 'waitingForPhoto') {
      userStates[userid] = 'waitingForSeverity';

      try {
        const imageurl = await uploadImageFromLine(msg.id, userid);
        await pool.query(
          `UPDATE damagereport SET imageurl = $1 WHERE userid = $2 AND imageurl IS NULL`,
          [imageurl, userid]
        );
      } catch (err) {
        console.error('❌ S3アップロード処理中のエラー:', err);
      }

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害状況のレベルを選択してください',
        quickReply: {
          items: [
            { type: 'action', action: { type: 'message', label: '軽微', text: '軽微' } },
            { type: 'action', action: { type: 'message', label: '中程度', text: '中程度' } },
            { type: 'action', action: { type: 'message', label: '重大', text: '重大' } }
          ]
        }
      });
    }

    if (msg.type === 'text' && userStates[userid] === 'waitingForSeverity') {
      console.log('✅ entering severity branch for', userid);

      // 1) 状態更新
      userStates[userid] = 'done';

      // 2) DB 更新
      await pool.query(
        `UPDATE damagereport 
        SET severity = $1 
        WHERE userid = $2 
        AND severity IS NULL`,
        [msg.text, userid]
      );

      // 3) 報告者への返信
      await client.replyMessage(event.replyToken, [
        {
          type: 'text',
          text: `ありがとうございます。「${msg.text}」として記録しました。ご協力ありがとうございました！`
        },
        getMenuButtons()
      ]);
      console.log('✅ reply sent to reporter');

      // 4) 管理者一覧取得
      const admins = await getAdminUserIds();
      console.log('ℹ️ admins to notify:', admins);

      // 5) 管理者へのプッシュ通知
      if (admins.length > 0) {
        const pushText = ` 新しい被害報告が届きました
        ・ユーザーID: ${userid}
        ・レベル: ${msg.text}`;
        try {
          if (admins.length === 1) {
            await client.pushMessage(admins[0], { type: 'text', text: pushText });
          }
          else {
            await client.multicast(admins, { type: 'text', text: pushText });
          }
          console.log('✅ 管理者に通知を送信:', admins);
        } catch (err) {
          console.error('❌ 管理者への通知エラー:', err);
        }
      }

      return;
    }
  }

  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 LINE Bot is running on port ${port}`);
});


