import {
  SQSClient,
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

const client = new SQSClient({
  region: process.env.AWS_REGION!,
  endpoint: process.env.AWS_ENDPOINT!,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

async function waitForSqs(): Promise<void> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await client.send(new ListQueuesCommand({}));
      return;
    } catch {
      console.log(`SQS ainda não respondeu (tentativa ${attempt}/30)...`);
      await Bun.sleep(1000);
    }
  }
  throw new Error('SQS indisponível após 30 tentativas');
}

async function createQueue(name: string, attributes: Record<string, string>): Promise<string> {
  const { QueueUrl } = await client.send(
    new CreateQueueCommand({ QueueName: name, Attributes: attributes }),
  );
  if (!QueueUrl) throw new Error(`Falha ao criar ${name}`);
  console.log(`✔ ${name} → ${QueueUrl}`);
  return QueueUrl;
}

async function main(): Promise<void> {
  await waitForSqs();

  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlqUrl = await createQueue(process.env.SQS_WAGER_DLQ!, fifo);
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = Attributes?.QueueArn;
  if (!dlqArn) throw new Error('DLQ sem ARN');

  // Atributos mutáveis aplicados à parte: rodar o script de novo atualiza uma fila já existente
  const mainUrl = await createQueue(process.env.SQS_WAGER_QUEUE!, fifo);
  await client.send(
    new SetQueueAttributesCommand({
      QueueUrl: mainUrl,
      Attributes: {
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: process.env.SQS_MAX_RECEIVE_COUNT ?? '10',
        }),
      },
    }),
  );

  await createQueue(process.env.SQS_EVENTS_QUEUE!, fifo);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});