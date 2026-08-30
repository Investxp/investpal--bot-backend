import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNotificationService,
} from '../dist/notifications.js';

test('sends email notifications for significant events', () => {
  const notifier = createNotificationService();

  const sent = notifier.sendEmailNotification({
    accountId: 'acct-1',
    email: 'user@example.com',
    subject: 'Trade Executed',
    body: 'Your trade has been executed successfully',
  });

  assert.ok(sent.notificationId);
  assert.equal(sent.channel, 'email');
  assert.equal(sent.status, 'sent');
});

test('logs delivery status for retry logic', () => {
  const notifier = createNotificationService();

  const sent = notifier.sendEmailNotification({
    accountId: 'acct-2',
    email: 'user@example.com',
    subject: 'Test',
    body: 'Test notification',
  });

  const delivery = notifier.getDeliveryStatus(sent.notificationId);
  assert.ok(delivery);
  assert.ok(delivery.sentAt);
});

test('supports SMS notifications', () => {
  const notifier = createNotificationService();

  const sent = notifier.sendSMSNotification({
    accountId: 'acct-3',
    phoneNumber: '+1234567890',
    message: 'Trade alert: R_100 crossed above MA',
  });

  assert.ok(sent.notificationId);
  assert.equal(sent.channel, 'sms');
});

test('supports Telegram notifications', () => {
  const notifier = createNotificationService();

  const sent = notifier.sendTelegramNotification({
    accountId: 'acct-4',
    chatId: '123456789',
    message: 'Your stop loss has been triggered',
  });

  assert.ok(sent.notificationId);
  assert.equal(sent.channel, 'telegram');
});

test('supports in-app notifications', () => {
  const notifier = createNotificationService();

  const sent = notifier.sendInAppNotification({
    accountId: 'acct-5',
    title: 'Position Update',
    message: 'Your position has been closed at profit',
    type: 'success',
  });

  assert.ok(sent.notificationId);
  assert.equal(sent.channel, 'in-app');
});

test('batches notifications by account for efficiency', () => {
  const notifier = createNotificationService();

  const batch = notifier.createNotificationBatch('acct-6');
  batch.addEmailNotification({
    email: 'user@example.com',
    subject: 'Alert 1',
    body: 'First alert',
  });
  batch.addEmailNotification({
    email: 'user@example.com',
    subject: 'Alert 2',
    body: 'Second alert',
  });

  const result = batch.send();
  assert.equal(result.count, 2);
  assert.equal(result.successful, 2);
});

test('implements retry logic for failed notifications', () => {
  const notifier = createNotificationService({ maxRetries: 3 });

  const sent = notifier.sendEmailNotification({
    accountId: 'acct-7',
    email: 'user@example.com',
    subject: 'Test',
    body: 'Test message',
  });

  // Simulate retry
  const retried = notifier.retryNotification(sent.notificationId);
  assert.ok(retried);
});

test('provides notification history for audit trail', () => {
  const notifier = createNotificationService();

  notifier.sendEmailNotification({
    accountId: 'acct-8',
    email: 'user@example.com',
    subject: 'Alert',
    body: 'Test alert',
  });

  notifier.sendSMSNotification({
    accountId: 'acct-8',
    phoneNumber: '+1234567890',
    message: 'SMS alert',
  });

  const history = notifier.getNotificationHistory('acct-8');
  assert.equal(history.length, 2);
});
