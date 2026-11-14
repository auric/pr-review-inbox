from jobs.dispatcher import Dispatcher


def log_event(event):
    print(f"event {event.kind}")


def build():
    return Dispatcher([log_event])
