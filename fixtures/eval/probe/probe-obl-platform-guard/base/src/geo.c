#include "geo.h"

#include <math.h>

#define EARTH_RADIUS_KM 6371.0

static double rad(double deg) { return deg * M_PI / 180.0; }

double geo_distance(double lat1, double lon1, double lat2, double lon2) {
  double a = pow(sin(rad(lat2 - lat1) / 2), 2) + cos(rad(lat1)) * cos(rad(lat2)) * pow(sin(rad(lon2 - lon1) / 2), 2);
  return 2 * EARTH_RADIUS_KM * asin(sqrt(a));
}

double geo_bearing(double lat1, double lon1, double lat2, double lon2) {
  double y = sin(rad(lon2 - lon1)) * cos(rad(lat2));
  double x = cos(rad(lat1)) * sin(rad(lat2)) - sin(rad(lat1)) * cos(rad(lat2)) * cos(rad(lon2 - lon1));
  return fmod(atan2(y, x) * 180.0 / M_PI + 360.0, 360.0);
}
