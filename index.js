const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: 'nV+RSgDu9WIwsFP8SxOTl3o36Rf7aHAZcWrHzib4uo+8m3EahDat6eDovdWNffNX98Gcolf/kPSZAamKqxiSFLL30Mp2Y3C7Pw7JM1DPM2RI4r4pNCpiqDurs2KTZKMgmoIEy2ljmm8NG9bUqOMnmgdB04t89/1O/w1cDnyilFU=',
  channelSecret: 'aa2248ab5d0c0bf870603c186d257147'
};

const app = express();
const client = new line.Client(config);

// 簡易的な状態保持（本番ではデータベース推奨）
const userStates = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('Webhookハンドラーでエラー:', err);
      res.status(500).end();
    });
});

function handleEvent(event) {
  const userId = event.source.userId;

  // 画像を受け取った場合
  if (event.message?.type === 'image' && userStates[userId] === 'waitingForPhoto') {
    userStates[userId] = 'photoReceived';
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '被害状況のレベルを教えてください（軽微・中程度・重大）'
    });
  }

  // テキストメッセージ処理
  if (event.type === 'message' && event.message.type === 'text') {
    const userMessage = event.message.text.trim();

    // 報告開始
    if (userMessage === '報告') {
      userStates[userId] = 'waitingForPhoto';
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '写真を共有してください'
      });
    }

    // 被害レベルの入力処理
    if (userStates[userId] === 'photoReceived') {
      userStates[userId] = 'done'; // 状態リセット or 保存処理
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: `ありがとうございます。「${userMessage}」として報告を記録しました。`
      });
    }

    // それ以外のテキストは無視
    return Promise.resolve(null);
  }

  // 該当しないイベントは無視
  return Promise.resolve(null);
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 LINE Bot is running on port ${port}`);
});
