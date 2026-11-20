#include <stdio.h>

#include "clock.h"

int main(void) {
  printf("%lld\n", (long long)clock_uptime_ms());
  return 0;
}
