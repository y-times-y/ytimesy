/**
 * Shows a desktop notification, or does nothing when the browser cannot.
 *
 * `new Notification()` throws on some browsers even when permission is
 * granted (Chrome on Android only allows it through a service worker, and some
 * embedded browsers throw "Illegal constructor"). The callers run it inside a
 * React effect, so an uncaught throw reached the error boundary: a
 * "Something went wrong / Try again" page over a chat whose message had been
 * sent. A notification is only a nicety, so a failure here is swallowed.
 */
export function showNotification(
	title: string,
	options: NotificationOptions,
	onClick: () => void,
) {
	if (typeof Notification === "undefined") return;
	if (Notification.permission !== "granted") return;
	try {
		const notification = new Notification(title, options);
		notification.onclick = () => {
			window.focus();
			onClick();
			notification.close();
		};
	} catch {
		// Not supported here; the tab-title dot still shows.
	}
}

/** Asks once whether notifications may be shown; never throws. */
export function requestNotificationPermission() {
	try {
		if (typeof Notification === "undefined") return;
		if (Notification.permission !== "default") return;
		void Promise.resolve(Notification.requestPermission()).catch(
			() => undefined,
		);
	} catch {
		// Some browsers refuse the request outside a user gesture.
	}
}
