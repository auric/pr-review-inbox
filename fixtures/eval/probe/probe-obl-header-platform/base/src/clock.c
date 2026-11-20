#include "clock.h"

#ifdef _WIN32
#include <windows.h>

int64_t clock_uptime_ms(void) {
  LARGE_INTEGER freq, now;
  if (!QueryPerformanceFrequency(&freq) || !QueryPerformanceCounter(&now)) return 0;
  return (int64_t)(now.QuadPart / freq.QuadPart * 1000 + now.QuadPart % freq.QuadPart * 1000 / freq.QuadPart);
}
#else
#include <time.h>

int64_t clock_uptime_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}
#endif
