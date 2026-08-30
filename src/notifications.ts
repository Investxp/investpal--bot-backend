import { randomUUID } from 'crypto';

export type NotificationChannel = 'email' | 'sms' | 'telegram' | 'in-app';

export interface Notification {
  notificationId: string;
  accountId: string;
  channel: NotificationChannel;
  status: 'sent' | 'pending' | 'failed';
  sentAt?: string;
  attempts: number;
}

export interface EmailNotificationInput {
  accountId: string;
  email: string;
  subject: string;
  body: string;
}

export interface SMSNotificationInput {
  accountId: string;
  phoneNumber: string;
  message: string;
}

export interface TelegramNotificationInput {
  accountId: string;
  chatId: string;
  message: string;
}

export interface InAppNotificationInput {
  accountId: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
}

export interface DeliveryStatus {
  notificationId: string;
  channel: NotificationChannel;
  status: string;
  sentAt: string;
  attempts: number;
  lastError?: string;
}

export interface NotifierOptions {
  maxRetries?: number;
}

export function createNotificationService(options: NotifierOptions = {}) {
  const maxRetries = options.maxRetries ?? 3;
  const notifications = new Map<string, Notification>();
  const delivery = new Map<string, DeliveryStatus>();
  const history = new Map<string, Notification[]>();

  return {
    sendEmailNotification(input: EmailNotificationInput): Notification {
      const notificationId = randomUUID();
      const notification: Notification = {
        notificationId,
        accountId: input.accountId,
        channel: 'email',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      };

      notifications.set(notificationId, notification);

      delivery.set(notificationId, {
        notificationId,
        channel: 'email',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      });

      if (!history.has(input.accountId)) {
        history.set(input.accountId, []);
      }
      history.get(input.accountId)!.push(notification);

      return notification;
    },

    sendSMSNotification(input: SMSNotificationInput): Notification {
      const notificationId = randomUUID();
      const notification: Notification = {
        notificationId,
        accountId: input.accountId,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      };

      notifications.set(notificationId, notification);
      delivery.set(notificationId, {
        notificationId,
        channel: 'sms',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      });

      if (!history.has(input.accountId)) {
        history.set(input.accountId, []);
      }
      history.get(input.accountId)!.push(notification);

      return notification;
    },

    sendTelegramNotification(input: TelegramNotificationInput): Notification {
      const notificationId = randomUUID();
      const notification: Notification = {
        notificationId,
        accountId: input.accountId,
        channel: 'telegram',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      };

      notifications.set(notificationId, notification);
      delivery.set(notificationId, {
        notificationId,
        channel: 'telegram',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      });

      if (!history.has(input.accountId)) {
        history.set(input.accountId, []);
      }
      history.get(input.accountId)!.push(notification);

      return notification;
    },

    sendInAppNotification(input: InAppNotificationInput): Notification {
      const notificationId = randomUUID();
      const notification: Notification = {
        notificationId,
        accountId: input.accountId,
        channel: 'in-app',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      };

      notifications.set(notificationId, notification);
      delivery.set(notificationId, {
        notificationId,
        channel: 'in-app',
        status: 'sent',
        sentAt: new Date().toISOString(),
        attempts: 1,
      });

      if (!history.has(input.accountId)) {
        history.set(input.accountId, []);
      }
      history.get(input.accountId)!.push(notification);

      return notification;
    },

    getDeliveryStatus(notificationId: string): DeliveryStatus | null {
      return delivery.get(notificationId) ?? null;
    },

    retryNotification(notificationId: string): boolean {
      const notif = notifications.get(notificationId);
      if (!notif || notif.attempts >= maxRetries) return false;

      notif.attempts += 1;
      notif.status = 'pending';

      return true;
    },

    getNotificationHistory(accountId: string): Notification[] {
      return [...(history.get(accountId) ?? [])];
    },

    createNotificationBatch(accountId: string) {
      const batch: Notification[] = [];

      return {
        addEmailNotification(input: Omit<EmailNotificationInput, 'accountId'>) {
          const notificationId = randomUUID();
          batch.push({
            notificationId,
            accountId,
            channel: 'email',
            status: 'pending',
            attempts: 0,
          });
        },

        addSMSNotification(input: Omit<SMSNotificationInput, 'accountId'>) {
          const notificationId = randomUUID();
          batch.push({
            notificationId,
            accountId,
            channel: 'sms',
            status: 'pending',
            attempts: 0,
          });
        },

        send() {
          let successful = 0;
          for (const notif of batch) {
            notif.status = 'sent';
            notif.sentAt = new Date().toISOString();
            notif.attempts = 1;
            notifications.set(notif.notificationId, notif);
            successful++;
          }

          return { count: batch.length, successful };
        },
      };
    },

    clear(): void {
      notifications.clear();
      delivery.clear();
      history.clear();
    },
  };
}
