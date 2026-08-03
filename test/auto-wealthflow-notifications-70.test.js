import { describe, it, expect, beforeEach } from 'vitest';

describe('wealthflow-notifications', () => {
  let windowShim;
  let localStorageShim;

  beforeEach(() => {
    windowShim = {
      DB: {
        get: (key) => {
          if (key === 'cheques') {
            return [
              { id: '1', status: 'pending', release: '2023-01-01', party: 'John Doe', amount: 1000, type: 'issued', bank: 'Bank A' },
              { id: '2', status: 'pending', release: '2023-01-02', no: '12345', amount: 2000, type: 'received' },
              { id: '3', status: 'cleared', release: '2023-01-03', party: 'Jane Smith', amount: 3000, type: 'issued' },
            ];
          }
          return [];
        },
        getObj: (key) => {
          if (key === 'settings') {
            return {
              notif: {
                enabled: true,
                urgent: true,
                dueSoon: true,
                cheques: true,
              },
            };
          }
          return {};
        },
        set: () => {},
      },
    };

    localStorageShim = {
      getItem: (key) => {
        if (key === 'wf2_notif_seen') {
          return JSON.stringify({});
        }
        if (key === 'wf2_notif_pushed') {
          return JSON.stringify({});
        }
        return null;
      },
      setItem: () => {},
    };

    global.window = windowShim;
    global.localStorage = localStorageShim;
  });

  it('should compute notifications for pending cheques', async () => {
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual({
      id: 'chq:1',
      sev: 'urgent',
      cat: 'Cheque',
      icon: 'cheque',
      title: 'Issued cheque overdue — John Doe',
      sub: '1,000 \u00b7 Bank A',
      when: '1d over',
      date: '2023-01-01',
      page: 'cheques',
    });
    expect(notifications[1]).toEqual({
      id: 'chq:2',
      sev: 'urgent',
      cat: 'Cheque',
      icon: 'cheque',
      title: 'Received cheque due today — 12345',
      sub: '2,000',
      when: 'Today',
      date: '2023-01-02',
      page: 'cheques',
    });
  });

  it('should not compute notifications for cleared cheques', async () => {
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).not.toContainEqual(expect.objectContaining({
      id: 'chq:3',
    }));
  });

  it('should handle empty cheques array', async () => {
    windowShim.DB.get = () => [];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(0);
  });

  it('should handle null and undefined values in cheques', async () => {
    windowShim.DB.get = () => [null, undefined, { id: '4', status: 'pending', release: '2023-01-04', party: 'Alice', amount: 4000, type: 'issued' }];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
      id: 'chq:4',
      sev: 'urgent',
      cat: 'Cheque',
      icon: 'cheque',
      title: 'Issued cheque overdue — Alice',
      sub: '4,000',
      when: '3d over',
      date: '2023-01-04',
      page: 'cheques',
    });
  });

  it('should handle malformed dates in cheques', async () => {
    windowShim.DB.get = () => [{ id: '5', status: 'pending', release: 'invalid-date', party: 'Bob', amount: 5000, type: 'issued' }];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(0);
  });

  it('should handle negative amounts in cheques', async () => {
    windowShim.DB.get = () => [{ id: '6', status: 'pending', release: '2023-01-06', party: 'Charlie', amount: -6000, type: 'issued' }];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].sub).toBe('-6,000');
  });

  it('should handle huge amounts in cheques', async () => {
    windowShim.DB.get = () => [{ id: '7', status: 'pending', release: '2023-01-07', party: 'Dave', amount: 7000000000, type: 'issued' }];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].sub).toBe('7,000,000,000');
  });

  it('should handle unicode characters in cheques', async () => {
    windowShim.DB.get = () => [{ id: '8', status: 'pending', release: '2023-01-08', party: 'Élodie', amount: 8000, type: 'issued', bank: 'Bank B' }];
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Issued cheque overdue — Élodie');
    expect(notifications[0].sub).toBe('8,000 \u00b7 Bank B');
  });

  it('should handle missing settings', async () => {
    windowShim.DB.getObj = () => ({});
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(2);
  });

  it('should handle disabled notifications', async () => {
    windowShim.DB.getObj = () => ({
      notif: {
        enabled: false,
        urgent: true,
        dueSoon: true,
        cheques: true,
      },
    });
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(0);
  });

  it('should handle disabled urgent notifications', async () => {
    windowShim.DB.getObj = () => ({
      notif: {
        enabled: true,
        urgent: false,
        dueSoon: true,
        cheques: true,
      },
    });
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(0);
  });

  it('should handle disabled dueSoon notifications', async () => {
    windowShim.DB.getObj = () => ({
      notif: {
        enabled: true,
        urgent: true,
        dueSoon: false,
        cheques: true,
      },
    });
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].sev).toBe('urgent');
  });

  it('should handle disabled cheques notifications', async () => {
    windowShim.DB.getObj = () => ({
      notif: {
        enabled: true,
        urgent: true,
        dueSoon: true,
        cheques: false,
      },
    });
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(0);
  });

  it('should handle localStorage errors', async () => {
    localStorageShim.getItem = () => {
      throw new Error('localStorage error');
    };
    await import('../wealthflow-notifications.js');

    const notifications = windowShim.compute();

    expect(notifications).toHaveLength(2);
  });
});
