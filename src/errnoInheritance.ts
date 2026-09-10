import { ErrnoCode } from "./errno";

export const ErrnoParent: Record<ErrnoCode, ErrnoCode> = {
    [ErrnoCode.EFAIL]: ErrnoCode.EFAIL, // Root of all normal exceptions
    [ErrnoCode.EPANIC]: ErrnoCode.EPANIC, // Root of all nonrecoverable exceptions

    // Custom errors
    [ErrnoCode.ENAME]: ErrnoCode.EFAIL,
    [ErrnoCode.EFUNC]: ErrnoCode.ENAME,
    [ErrnoCode.ESYNTAX]: ErrnoCode.EFAIL,
    [ErrnoCode.EJAVASCRIPT]: ErrnoCode.EFAIL,

    // Type/value validation errors
    [ErrnoCode.EINVAL]: ErrnoCode.EFAIL,            // Type error
    [ErrnoCode.ERANGE]: ErrnoCode.EFAIL,            // Value error
    [ErrnoCode.EDOM]: ErrnoCode.ERANGE,             // Numerical out of domain
    [ErrnoCode.EOVERFLOW]: ErrnoCode.EDOM,          // Value too large
    [ErrnoCode.EILSEQ]: ErrnoCode.ERANGE,           // Illegal byte sequence

    // Permission/access errors
    [ErrnoCode.EPERM]: ErrnoCode.EFAIL,             // Root
    [ErrnoCode.EACCES]: ErrnoCode.EPERM,            // Permission denied
    [ErrnoCode.EAUTH]: ErrnoCode.EPERM,             // Authentication error
    [ErrnoCode.ENEEDAUTH]: ErrnoCode.EPERM,         // Need authenticator
    [ErrnoCode.ENOTCAPABLE]: ErrnoCode.EPERM,       // Capabilities insufficient

    // Resource exhaustion errors
    [ErrnoCode.ENOMEM]: ErrnoCode.EFAIL,            // Root
    [ErrnoCode.ENFILE]: ErrnoCode.ENOMEM,           // Too many open files (system)
    [ErrnoCode.EMFILE]: ErrnoCode.ENOMEM,           // Too many open files
    [ErrnoCode.EDQUOT]: ErrnoCode.ENOMEM,           // Disk quota exceeded
    [ErrnoCode.ENOBUFS]: ErrnoCode.ENOMEM,          // No buffer space
    [ErrnoCode.EUSERS]: ErrnoCode.ENOMEM,           // Too many users
    [ErrnoCode.EPROCLIM]: ErrnoCode.ENOMEM,         // Too many processes
    [ErrnoCode.EQFULL]: ErrnoCode.ENOMEM,           // Output queue full
    [ErrnoCode.EREMOTE]: ErrnoCode.ENOMEM,          // Too many network requests

    // File system errors
    [ErrnoCode.ENOENT]: ErrnoCode.EFAIL,            // Root
    [ErrnoCode.ENOTDIR]: ErrnoCode.ENOENT,          // Not a directory
    [ErrnoCode.EISDIR]: ErrnoCode.ENOENT,           // Is a directory
    [ErrnoCode.ENOTEMPTY]: ErrnoCode.ENOENT,        // Directory not empty
    [ErrnoCode.ENAMETOOLONG]: ErrnoCode.ENOENT,     // File name too long
    [ErrnoCode.EEXIST]: ErrnoCode.ENOENT,           // File exists
    [ErrnoCode.EROFS]: ErrnoCode.ENOENT,            // Read-only filesystem
    [ErrnoCode.ENOSPC]: ErrnoCode.ENOENT,           // No space left
    [ErrnoCode.ESTALE]: ErrnoCode.ENOENT,           // Stale NFS handle
    [ErrnoCode.ELOOP]: ErrnoCode.ENOENT,            // Too many symlinks
    [ErrnoCode.EXDEV]: ErrnoCode.ENOENT,            // Cross-device link
    [ErrnoCode.EMLINK]: ErrnoCode.ENOENT,           // Too many links

    // I/O and device errors
    [ErrnoCode.EIO]: ErrnoCode.EFAIL,               // Root
    [ErrnoCode.EPIPE]: ErrnoCode.EIO,               // Broken pipe
    [ErrnoCode.ESPIPE]: ErrnoCode.EIO,              // Illegal seek
    [ErrnoCode.ETXTBSY]: ErrnoCode.EIO,             // Text file busy
    [ErrnoCode.EBADF]: ErrnoCode.EIO,               // Bad file descriptor
    [ErrnoCode.EFAULT]: ErrnoCode.EIO,              // Bad address
    [ErrnoCode.EBUSY]: ErrnoCode.EIO,               // Device/resource busy

    // Device/file type errors
    [ErrnoCode.ENODEV]: ErrnoCode.EFAIL,            // Root
    [ErrnoCode.ENOTBLK]: ErrnoCode.ENODEV,          // Block device required
    [ErrnoCode.ENOTTY]: ErrnoCode.ENODEV,           // Not a tty
    [ErrnoCode.EFBIG]: ErrnoCode.ENODEV,            // File too large
    [ErrnoCode.EFTYPE]: ErrnoCode.ENODEV,           // Inappropriate file type
    [ErrnoCode.EDEVERR]: ErrnoCode.ENODEV,          // Device error
    [ErrnoCode.EPWROFF]: ErrnoCode.ENODEV,          // Device power off

    // Executable/format errors
    [ErrnoCode.ENOEXEC]: ErrnoCode.EFAIL,           // Root
    [ErrnoCode.EBADARCH]: ErrnoCode.ENOEXEC,        // Bad CPU type
    [ErrnoCode.EBADEXEC]: ErrnoCode.ENOEXEC,        // Bad executable
    [ErrnoCode.ESHLIBVERS]: ErrnoCode.ENOEXEC,      // Shared library version mismatch
    [ErrnoCode.EBADMACHO]: ErrnoCode.ENOEXEC,       // Malformed Macho

    // Process/system errors
    [ErrnoCode.ECHILD]: ErrnoCode.EFAIL,            // Root
    [ErrnoCode.EDEADLK]: ErrnoCode.EFAIL,           // Root
    [ErrnoCode.EINTR]: ErrnoCode.EPANIC,            // Root
    [ErrnoCode.EAGAIN]: ErrnoCode.EFAIL,            // Root
    [ErrnoCode.ECANCELED]: ErrnoCode.EFAIL,         // Root
    [ErrnoCode.EIDRM]: ErrnoCode.EFAIL,             // Root
    [ErrnoCode.ENOTRECOVERABLE]: ErrnoCode.EPANIC,  // Root
    [ErrnoCode.EOWNERDEAD]: ErrnoCode.EFAIL,        // Root

    // Network/socket errors
    [ErrnoCode.ENOTSOCK]: ErrnoCode.EFAIL,          // Root
    [ErrnoCode.EDESTADDRREQ]: ErrnoCode.ENOTSOCK,   // Destination address required
    [ErrnoCode.EMSGSIZE]: ErrnoCode.ENOTSOCK,       // Message too long
    [ErrnoCode.EPROTOTYPE]: ErrnoCode.ENOTSOCK,     // Protocol wrong type
    [ErrnoCode.ENOPROTOOPT]: ErrnoCode.ENOTSOCK,    // Protocol not available
    [ErrnoCode.EPROTONOSUPPORT]: ErrnoCode.ENOTSOCK, // Protocol not supported
    [ErrnoCode.ESOCKTNOSUPPORT]: ErrnoCode.ENOTSOCK, // Socket type not supported
    [ErrnoCode.ENOTSUP]: ErrnoCode.ENOTSOCK,        // Operation not supported
    [ErrnoCode.EPFNOSUPPORT]: ErrnoCode.ENOTSOCK,   // Protocol family not supported
    [ErrnoCode.EAFNOSUPPORT]: ErrnoCode.ENOTSOCK,   // Address family not supported
    [ErrnoCode.EADDRINUSE]: ErrnoCode.ENOTSOCK,     // Address already in use
    [ErrnoCode.EADDRNOTAVAIL]: ErrnoCode.ENOTSOCK,  // Can't assign address
    [ErrnoCode.ENETDOWN]: ErrnoCode.ENOTSOCK,       // Network is down
    [ErrnoCode.ENETUNREACH]: ErrnoCode.ENOTSOCK,    // Network unreachable
    [ErrnoCode.ENETRESET]: ErrnoCode.ENOTSOCK,      // Network dropped connection
    [ErrnoCode.ECONNABORTED]: ErrnoCode.ENOTSOCK,   // Connection aborted
    [ErrnoCode.ECONNRESET]: ErrnoCode.ENOTSOCK,     // Connection reset
    [ErrnoCode.EISCONN]: ErrnoCode.ENOTSOCK,        // Socket already connected
    [ErrnoCode.ENOTCONN]: ErrnoCode.ENOTSOCK,       // Socket not connected
    [ErrnoCode.ESHUTDOWN]: ErrnoCode.ENOTSOCK,      // Can't send after shutdown
    [ErrnoCode.ETOOMANYREFS]: ErrnoCode.ENOTSOCK,   // Too many references
    [ErrnoCode.ETIMEDOUT]: ErrnoCode.ENOTSOCK,      // Operation timed out
    [ErrnoCode.ECONNREFUSED]: ErrnoCode.ENOTSOCK,   // Connection refused
    [ErrnoCode.EHOSTDOWN]: ErrnoCode.ENOTSOCK,      // Host is down
    [ErrnoCode.EHOSTUNREACH]: ErrnoCode.ENOTSOCK,   // No route to host

    // RPC errors
    [ErrnoCode.EBADRPC]: ErrnoCode.EFAIL,           // Root
    [ErrnoCode.ERPCMISMATCH]: ErrnoCode.EBADRPC,    // RPC version wrong
    [ErrnoCode.EPROGUNAVAIL]: ErrnoCode.EBADRPC,    // RPC prog not avail
    [ErrnoCode.EPROGMISMATCH]: ErrnoCode.EBADRPC,   // Program version wrong
    [ErrnoCode.EPROCUNAVAIL]: ErrnoCode.EBADRPC,    // Bad procedure
    [ErrnoCode.EPROTO]: ErrnoCode.EBADRPC,          // Protocol error

    // Stream/misc errors (singletons)
    [ErrnoCode.ESRCH]: ErrnoCode.EFAIL,
    [ErrnoCode.ENXIO]: ErrnoCode.EFAIL,
    [ErrnoCode.ENOLCK]: ErrnoCode.EFAIL,
    [ErrnoCode.ENOSYS]: ErrnoCode.EFAIL,
    [ErrnoCode.ENOMSG]: ErrnoCode.EFAIL,
    [ErrnoCode.ENOATTR]: ErrnoCode.EFAIL,
    [ErrnoCode.EBADMSG]: ErrnoCode.EBADMSG,
    [ErrnoCode.EMULTIHOP]: ErrnoCode.EMULTIHOP,
    [ErrnoCode.ENODATA]: ErrnoCode.ENODATA,
    [ErrnoCode.ENOLINK]: ErrnoCode.ENOLINK,
    [ErrnoCode.ENOSR]: ErrnoCode.ENOSR,
    [ErrnoCode.ENOSTR]: ErrnoCode.ENOSTR,
    [ErrnoCode.ETIME]: ErrnoCode.ETIME,
    [ErrnoCode.EOPNOTSUPP]: ErrnoCode.EOPNOTSUPP,
    [ErrnoCode.ENOPOLICY]: ErrnoCode.ENOPOLICY,
    [ErrnoCode.EINPROGRESS]: ErrnoCode.EINPROGRESS,
    [ErrnoCode.EALREADY]: ErrnoCode.EALREADY,
};

export const errnoIsSubclass = (sub: ErrnoCode, super_: ErrnoCode) => {
    for (var prev = undefined; prev != sub; prev = sub, sub = ErrnoParent[sub]) {
        if (sub === super_) return true;
    }
    return false;
}
