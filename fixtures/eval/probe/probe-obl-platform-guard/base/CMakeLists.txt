cmake_minimum_required(VERSION 3.20)
project(geo C)

add_library(geo SHARED src/geo.c)
target_include_directories(geo PUBLIC include)
set_target_properties(geo PROPERTIES C_VISIBILITY_PRESET hidden)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  # Only the symbols in geo.map leave the library.
  target_link_options(geo PRIVATE "-Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/geo.map")
  add_test(NAME exported_symbols COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/tests/check_symbols.sh $<TARGET_FILE:geo>)
endif()

enable_testing()
