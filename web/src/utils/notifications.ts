import { useStore } from "../store.js";

let permissionChecked = false;
let notificationPermission: NotificationPermission = "default";

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  
  if (!permissionChecked) {
    if (Notification.permission === "granted") {
      notificationPermission = "granted";
    } else if (Notification.permission !== "denied") {
      notificationPermission = await Notification.requestPermission();
    }
    permissionChecked = true;
  }
  
  return notificationPermission === "granted";
}

export function sendNotification(title: string, options?: NotificationOptions): void {
  if (!("Notification" in window)) return;
  
  if (notificationPermission === "default") {
    requestNotificationPermission();
  }
  
  if (notificationPermission === "granted") {
    new Notification(title, {
      icon: "/favicon.ico",
      ...options,
    });
  }
}

export function notifyJobComplete(sessionName: string, sessionId: string, isCurrentSession: boolean): void {
  if (!useStore.getState().notificationsEnabled) return;
  if (isCurrentSession) return;
  
  sendNotification("Job Complete", {
    body: `${sessionName} is waiting for input`,
    tag: sessionId,
    requireInteraction: false,
  });
}
