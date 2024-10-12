import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';

import { Redis } from '@upstash/redis';
import { createHash } from 'crypto';

async function bootstrap() {
  const homeserverUrl = process.env.HOME_SERVER_URL;
  const accessToken = process.env.TOKEN;
  const antiPUMEndpoint = process.env.ANTI_PUM_ENDPOINT_URL;

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });

  const rateLimitForSameMessage = Number(
    process.env.RATE_LIMIT_FOR_SAME_MESSAGE,
  );

  const storage = new SimpleFsStorageProvider('hello-bot.json');

  const client = new MatrixClient(homeserverUrl, accessToken, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  client.on('room.message', handleCommand);

  client.start().then(() => console.log('Bot started!'));

  async function resetLimit(sender: string, message: string) {
    await redis.hset('sender_' + sender, { sent_message_count: 1 });
    await redis.hset('sender_' + sender, {
      latest_message_hash: createHash('sha256').update(message).digest('hex'),
    });
  }

  async function handleCommand(roomId: string, event: any) {
    // Don't handle unhelpful events (ones that aren't text messages, are redacted, or sent by us)
    if (event['content']?.['msgtype'] !== 'm.text') return;
    if (event['sender'] === (await client.getUserId())) return;

    // Check to ensure that the `!hello` command is being run
    const body = event['content']['body'];
    if (body) {
      const message = String(body);
      // 频率限制
      const sender = String(event['sender']);
      if (await redis.hexists('sender_' + sender, 'latest_message_hash')) {
        const latestMessageHash = String(
          await redis.hget('sender_' + sender, 'latest_message_hash'),
        );
        const currentMessageHash = createHash('sha256')
          .update(message)
          .digest('hex');

        if (latestMessageHash == currentMessageHash) {
          console.log('检测到重复信息。可能是 spam。检查发送数');
          const sentMessageCount = Number(
            await redis.hget('sender_' + sender, 'sent_message_count'),
          );

          if (sentMessageCount < rateLimitForSameMessage) {
            console.log('发送数尚在可接受范围内。仅删除并增加风控值');
            await redis.hincrby('sender_' + sender, 'sent_message_count', 1);
            await client.replyNotice(
              roomId,
              event,
              '请不要反复发送同样的信息。继续这样操作将导致你被自动禁止并踢出群',
            );
            await client.redactEvent(
              roomId,
              event['event_id'],
              '请不要反复发送同样的消息。继续这样操作将导致你被自动禁止并踢出群',
            );
          } else {
            console.log('发送数超过可接受范围。执行自动 ban 人操作');
            await client.redactEvent(
              roomId,
              event['event_id'],
              '重复发言（超过上限）',
            );
            //todo: implement ban function
            await redis.hdel('sender_' + sender, 'sent_message_count');
            await redis.hdel('sender_' + sender, 'latest_message_hash');
          }
        } else {
          resetLimit(sender, message);
        }
      } else {
        resetLimit(sender, message);
      }

      // AI 检测垃圾信息
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
