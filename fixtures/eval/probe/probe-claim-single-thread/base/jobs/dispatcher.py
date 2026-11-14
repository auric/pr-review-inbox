import queue
import threading


class Dispatcher:
    """Runs the handlers for queued events."""

    def __init__(self, handlers):
        self._events = queue.Queue()
        self._handlers = list(handlers)
        self._thread = threading.Thread(target=self._run, name="dispatcher", daemon=True)

    def start(self):
        self._thread.start()

    def submit(self, event):
        # Any thread can submit. The queue is thread-safe.
        self._events.put(event)

    def _run(self):
        while True:
            event = self._events.get()
            if event is None:
                return
            for handler in self._handlers:
                handler(event)

    def stop(self):
        self._events.put(None)
        self._thread.join()
