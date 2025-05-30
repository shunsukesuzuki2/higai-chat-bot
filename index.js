const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const app = express();
const client = new line.Client(config);

// 状態記録（簡易） userId → 状態
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

  if (event.type === 'message') {
    const msg = event.message;

    //  位置情報受信 → 写真要求
    if (msg.type === 'location' && userStates[userId] === 'waitingForLocation') {
      userStates[userId] = 'waitingForPhoto';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `位置情報を受け取りました（${msg.address}）。次に写真を共有してください。`
      });
    }

    //  写真受信 → 被害レベル要求
    if (msg.type === 'image' && userStates[userId] === 'waitingForPhoto') {
      userStates[userId] = 'waitingForSeverity';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害状況のレベルを教えてください（軽微・中程度・重大）'
      });
    }

    //  被害レベル受信 → 完了
    if (msg.type === 'text' && userStates[userId] === 'waitingForSeverity') {
      userStates[userId] = 'done';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ありがとうございます。「${msg.text}」として記録しました。ご協力ありがとうございました！`
      });
    }

    // 「報告」開始 → 位置情報要求
    if (msg.type === 'text' && msg.text.trim() === '報告') {
      userStates[userId] = 'waitingForLocation';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '被害の位置情報を送ってください'
      });
    }
  }

  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 LINE Bot is running on port ${port}`);
});

