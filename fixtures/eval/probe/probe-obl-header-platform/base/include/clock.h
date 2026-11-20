#ifndef CLOCK_H
#define CLOCK_H

#include <stdint.h>

/* Returns the time since boot in milliseconds.
 * On Linux, returns 0 when the monotonic clock fails.
 * On Windows, returns 0 when the performance counter fails.
 */
int64_t clock_uptime_ms(void);

#endif
