import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';

async function bootstrap() {
  const homeserverUrl = process.env.HOME_SERVER_URL;
  const accessToken = process.env.TOKEN;
  const antiPUMEndpoint = process.env.ANTI_PUM_ENDPOINT_URL;

  const storage = new SimpleFsStorageProvider('hello-bot.json');

  const client = new MatrixClient(homeserverUrl, accessToken, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  client.on('room.message', handleCommand);

  client.start().then(() => console.log('Bot started!'));

  async function handleCommand(roomId: string, event: any) {
    // Don't handle unhelpful events (ones that aren't text messages, are redacted, or sent by us)
    if (event['content']?.['msgtype'] !== 'm.text') return;
    if (event['sender'] === (await client.getUserId())) return;

    // Check to ensure that the `!hello` command is being run
    const body = event['content']['body'];
    if (body) {
      const message = String(body);
      if (message.length > 50) {
        console.log('检测到潜在的垃圾消息，正在调用 API 检测');
        const response = await fetch(antiPUMEndpoint, {
          method: 'POST',
          body: JSON.stringify({
            message: message,
          }),
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
          },
        });

        console.log('调用完成');

        if (response.json !== null) {
          try {
            console.log('解析返回结果');
            const result = await response.json();
            console.log(result);
            if (result.response !== null && String(result.response) == 'true') {
              console.log('确认为 spam。提示并删除信息');
              await client.redactEvent(
                roomId,
                event['event_id'],
                '潜在的今日少年 spam！请不要发送此类信息，它们在群组内不受欢迎',
              );
            }
          } catch (e) {
            console.log(e);
            return;
          }
        }
      }
    } else return;
  }

  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
bootstrap();
