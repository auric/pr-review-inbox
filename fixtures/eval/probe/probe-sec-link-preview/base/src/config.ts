// The operator sets these values at deploy time. A request never changes them.
export const ALLOWED_FETCH_HOSTS = (process.env.ALLOWED_FETCH_HOSTS ?? "images.example.test").split(",");
