#pragma once
#include <string>
namespace std {
  template <>
  struct char_traits<unsigned char> {
    using char_type  = unsigned char;
    using int_type   = unsigned int;
    using off_type   = std::streamoff;
    using pos_type   = std::streampos;
    using state_type = std::mbstate_t;
    static void assign(char_type& c1, const char_type& c2) noexcept { c1 = c2; }
    static bool eq(char_type c1, char_type c2) noexcept { return c1 == c2; }
    static bool lt(char_type c1, char_type c2) noexcept { return c1 < c2; }
    static int compare(const char_type* s1, const char_type* s2, size_t n) { return memcmp(s1, s2, n); }
    static size_t length(const char_type* s) { size_t i = 0; while (s[i]) ++i; return i; }
    static const char_type* find(const char_type* s, size_t n, const char_type& a) { return (const char_type*)memchr(s, a, n); }
    static char_type* move(char_type* s1, const char_type* s2, size_t n) { return (char_type*)memmove(s1, s2, n); }
    static char_type* copy(char_type* s1, const char_type* s2, size_t n) { return (char_type*)memcpy(s1, s2, n); }
    static char_type* assign(char_type* s, size_t n, char_type a) { return (char_type*)memset(s, a, n); }
    static int_type not_eof(int_type c) noexcept { return c != eof() ? c : 0; }
    static char_type to_char_type(int_type c) noexcept { return (char_type)c; }
    static int_type to_int_type(char_type c) noexcept { return (int_type)c; }
    static bool eq_int_type(int_type c1, int_type c2) noexcept { return c1 == c2; }
    static int_type eof() noexcept { return (int_type)EOF; }
  };
}
