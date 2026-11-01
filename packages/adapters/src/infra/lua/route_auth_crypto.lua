-- OpenSSL primitives already linked by OpenResty. No custom cryptographic algorithm.
-- Used both in the request VM (HMAC only) and bounded worker VMs (PBKDF2).
local ffi = require "ffi"
ffi.cdef[[
typedef struct evp_md_st EVP_MD;
const EVP_MD *EVP_sha256(void);
unsigned char *HMAC(const EVP_MD *, const void *, int, const unsigned char *, size_t,
                    unsigned char *, unsigned int *);
int PKCS5_PBKDF2_HMAC(const char *, int, const unsigned char *, int, int,
                     const EVP_MD *, int, unsigned char *);
int CRYPTO_memcmp(const void *, const void *, size_t);
]]
local C = ffi.C
local M = {}
function M.unhex(value)
    if type(value) ~= "string" or #value % 2 ~= 0 or value:find("[^0-9a-f]") then return nil end
    return (value:gsub("..", function(pair) return string.char(tonumber(pair, 16)) end))
end
function M.hex(value)
    return (value:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end
function M.equal(a, b)
    return type(a) == "string" and type(b) == "string" and #a == #b and C.CRYPTO_memcmp(a, b, #a) == 0
end
function M.sign(key, value)
    local out, length = ffi.new("unsigned char[32]"), ffi.new("unsigned int[1]")
    if C.HMAC(C.EVP_sha256(), key, #key, value, #value, out, length) == nil or length[0] ~= 32 then
        error("Route signature unavailable")
    end
    return M.hex(ffi.string(out, 32))
end
function M.verify_password(password, salt_hex, verifier_hex)
    -- Bound every input again at the expensive-work boundary.
    if type(password) ~= "string" or #password > 256 then return false end
    local salt, verifier = M.unhex(salt_hex), M.unhex(verifier_hex)
    if not salt or #salt ~= 32 or not verifier or #verifier ~= 32 then return false end
    local out = ffi.new("unsigned char[32]")
    if C.PKCS5_PBKDF2_HMAC(password, #password, salt, #salt, 600000, C.EVP_sha256(), 32, out) ~= 1 then
        error("Route password verification unavailable")
    end
    return M.equal(ffi.string(out, 32), verifier)
end
return M
