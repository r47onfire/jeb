/**
 * @fileoverview
 * AUTO-GENERATED! DO NOT EDIT!
 * Checked files:
 * * /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/sys/errno.h
 * * /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/errno.h
 */
/**
 * Errno database mapping E-code to value
 */
export enum ErrnoCode {
    /**
     * Unspecified error
     */
    EFAIL = 0,
    /**
     * No such variable
     */
    ENAME = -1,
    /**
     * No such function
     */
    EFUNC = -2,
    /**
     * Unrecognized syntax
     */
    ESYNTAX = -3,
    /**
     * Javascript error
     */
    EJAVASCRIPT = -4,
    /**
     * Internal error
     */
    EPANIC = -255,
    /**
     * HTTP error
     */
    EHTTP = 1000,
    /**
     * Bye
     */
    EKICKED = 221,
    /**
     * Bad request
     */
    EBADREQ = 400,
    /**
     * Unauthorized
     */
    EUNAUTH = 401,
    /**
     * Forbidden
     */
    EREFUSED = 403,
    /**
     * Not found
     */
    ENOTFOUND = 404,
    /**
     * I'm a teapot
     */
    ETEAPOT = 418,
    /**
     * Too many requests
     */
    ERATELIMIT = 429,
    /**
     * Unavailable for legal reasons
     */
    ELAWYER = 451,
    /**
     * Internal server error
     */
    ESERVERERROR = 500,
    /**
     * Bad gateway
     */
    EUPSTREAM = 502,
    /**
     * Gateway timeout
     */
    EPROXYWAIT = 504,
    /**
     * Request denied
     */
    ELOGIN = 999,
    /**
     * Operation not permitted
     */
    EPERM = 1,
    /**
     * No such file or directory
     */
    ENOENT = 2,
    /**
     * No such process
     */
    ESRCH = 3,
    /**
     * Interrupted system call
     */
    EINTR = 4,
    /**
     * Input/output error
     */
    EIO = 5,
    /**
     * Device not configured
     */
    ENXIO = 6,
    /**
     * Exec format error
     */
    ENOEXEC = 8,
    /**
     * Bad file descriptor
     */
    EBADF = 9,
    /**
     * No child processes
     */
    ECHILD = 10,
    /**
     * Resource deadlock avoided
     */
    EDEADLK = 11,
    /**
     * Cannot allocate memory
     */
    ENOMEM = 12,
    /**
     * Permission denied
     */
    EACCES = 13,
    /**
     * Bad address
     */
    EFAULT = 14,
    /**
     * Block device required
     */
    ENOTBLK = 15,
    /**
     * Device / Resource busy
     */
    EBUSY = 16,
    /**
     * File exists
     */
    EEXIST = 17,
    /**
     * Cross-device link
     */
    EXDEV = 18,
    /**
     * Operation not supported by device
     */
    ENODEV = 19,
    /**
     * Not a directory
     */
    ENOTDIR = 20,
    /**
     * Is a directory
     */
    EISDIR = 21,
    /**
     * Invalid argument
     */
    EINVAL = 22,
    /**
     * Too many open files in system
     */
    ENFILE = 23,
    /**
     * Too many open files
     */
    EMFILE = 24,
    /**
     * Inappropriate ioctl for device
     */
    ENOTTY = 25,
    /**
     * Text file busy
     */
    ETXTBSY = 26,
    /**
     * File too large
     */
    EFBIG = 27,
    /**
     * No space left on device
     */
    ENOSPC = 28,
    /**
     * Illegal seek
     */
    ESPIPE = 29,
    /**
     * Read-only file system
     */
    EROFS = 30,
    /**
     * Too many links
     */
    EMLINK = 31,
    /**
     * Broken pipe
     */
    EPIPE = 32,
    /**
     * Numerical argument out of domain
     */
    EDOM = 33,
    /**
     * Result too large
     */
    ERANGE = 34,
    /**
     * Resource temporarily unavailable
     */
    EAGAIN = 35,
    /**
     * Operation now in progress
     */
    EINPROGRESS = 36,
    /**
     * Operation already in progress
     */
    EALREADY = 37,
    /**
     * Socket operation on non-socket
     */
    ENOTSOCK = 38,
    /**
     * Destination address required
     */
    EDESTADDRREQ = 39,
    /**
     * Message too long
     */
    EMSGSIZE = 40,
    /**
     * Protocol wrong type for socket
     */
    EPROTOTYPE = 41,
    /**
     * Protocol not available
     */
    ENOPROTOOPT = 42,
    /**
     * Protocol not supported
     */
    EPROTONOSUPPORT = 43,
    /**
     * Socket type not supported
     */
    ESOCKTNOSUPPORT = 44,
    /**
     * Operation not supported
     */
    ENOTSUP = 45,
    /**
     * Protocol family not supported
     */
    EPFNOSUPPORT = 46,
    /**
     * Address family not supported by protocol family
     */
    EAFNOSUPPORT = 47,
    /**
     * Address already in use
     */
    EADDRINUSE = 48,
    /**
     * Can't assign requested address
     */
    EADDRNOTAVAIL = 49,
    /**
     * Network is down
     */
    ENETDOWN = 50,
    /**
     * Network is unreachable
     */
    ENETUNREACH = 51,
    /**
     * Network dropped connection on reset
     */
    ENETRESET = 52,
    /**
     * Software caused connection abort
     */
    ECONNABORTED = 53,
    /**
     * Connection reset by peer
     */
    ECONNRESET = 54,
    /**
     * No buffer space available
     */
    ENOBUFS = 55,
    /**
     * Socket is already connected
     */
    EISCONN = 56,
    /**
     * Socket is not connected
     */
    ENOTCONN = 57,
    /**
     * Can't send after socket shutdown
     */
    ESHUTDOWN = 58,
    /**
     * Too many references: can't splice
     */
    ETOOMANYREFS = 59,
    /**
     * Operation timed out
     */
    ETIMEDOUT = 60,
    /**
     * Connection refused
     */
    ECONNREFUSED = 61,
    /**
     * Too many levels of symbolic links
     */
    ELOOP = 62,
    /**
     * File name too long
     */
    ENAMETOOLONG = 63,
    /**
     * Host is down
     */
    EHOSTDOWN = 64,
    /**
     * No route to host
     */
    EHOSTUNREACH = 65,
    /**
     * Directory not empty
     */
    ENOTEMPTY = 66,
    /**
     * Too many processes
     */
    EPROCLIM = 67,
    /**
     * Too many users
     */
    EUSERS = 68,
    /**
     * Disc quota exceeded
     */
    EDQUOT = 69,
    /**
     * Stale NFS file handle
     */
    ESTALE = 70,
    /**
     * Too many levels of remote in path
     */
    EREMOTE = 71,
    /**
     * RPC struct is bad
     */
    EBADRPC = 72,
    /**
     * RPC version wrong
     */
    ERPCMISMATCH = 73,
    /**
     * RPC prog. not avail
     */
    EPROGUNAVAIL = 74,
    /**
     * Program version wrong
     */
    EPROGMISMATCH = 75,
    /**
     * Bad procedure for program
     */
    EPROCUNAVAIL = 76,
    /**
     * No locks available
     */
    ENOLCK = 77,
    /**
     * Function not implemented
     */
    ENOSYS = 78,
    /**
     * Inappropriate file type or format
     */
    EFTYPE = 79,
    /**
     * Authentication error
     */
    EAUTH = 80,
    /**
     * Need authenticator
     */
    ENEEDAUTH = 81,
    /**
     * Device power is off
     */
    EPWROFF = 82,
    /**
     * Device error, e.g. paper out
     */
    EDEVERR = 83,
    /**
     * Value too large to be stored in data type
     */
    EOVERFLOW = 84,
    /**
     * Bad executable
     */
    EBADEXEC = 85,
    /**
     * Bad CPU type in executable
     */
    EBADARCH = 86,
    /**
     * Shared library version mismatch
     */
    ESHLIBVERS = 87,
    /**
     * Malformed Macho file
     */
    EBADMACHO = 88,
    /**
     * Operation canceled
     */
    ECANCELED = 89,
    /**
     * Identifier removed
     */
    EIDRM = 90,
    /**
     * No message of desired type
     */
    ENOMSG = 91,
    /**
     * Illegal byte sequence
     */
    EILSEQ = 92,
    /**
     * Attribute not found
     */
    ENOATTR = 93,
    /**
     * Bad message
     */
    EBADMSG = 94,
    /**
     * Reserved
     */
    EMULTIHOP = 95,
    /**
     * No message available on STREAM
     */
    ENODATA = 96,
    /**
     * Reserved
     */
    ENOLINK = 97,
    /**
     * No STREAM resources
     */
    ENOSR = 98,
    /**
     * Not a STREAM
     */
    ENOSTR = 99,
    /**
     * Protocol error
     */
    EPROTO = 100,
    /**
     * STREAM ioctl timeout
     */
    ETIME = 101,
    /**
     * Operation not supported on socket
     */
    EOPNOTSUPP = 102,
    /**
     * No such policy registered
     */
    ENOPOLICY = 103,
    /**
     * State not recoverable
     */
    ENOTRECOVERABLE = 104,
    /**
     * Previous owner died
     */
    EOWNERDEAD = 105,
    /**
     * Interface output queue is full
     */
    EQFULL = 106,
    /**
     * Capabilities insufficient
     */
    ENOTCAPABLE = 107,
};

/**
 * Errno database mapping E-code to string description default
 */
export const ErrnoDesc: Record<ErrnoCode, string> = {
    [ErrnoCode.EFAIL]: 'Unspecified error',
    [ErrnoCode.ENAME]: 'No such variable',
    [ErrnoCode.EFUNC]: 'No such function',
    [ErrnoCode.ESYNTAX]: 'Unrecognized syntax',
    [ErrnoCode.EJAVASCRIPT]: 'Javascript error',
    [ErrnoCode.EPANIC]: 'Internal error',
    [ErrnoCode.EHTTP]: 'HTTP error',
    [ErrnoCode.EKICKED]: 'Bye',
    [ErrnoCode.EBADREQ]: 'Bad request',
    [ErrnoCode.EUNAUTH]: 'Unauthorized',
    [ErrnoCode.EREFUSED]: 'Forbidden',
    [ErrnoCode.ENOTFOUND]: 'Not found',
    [ErrnoCode.ETEAPOT]: "I'm a teapot",
    [ErrnoCode.ERATELIMIT]: 'Too many requests',
    [ErrnoCode.ELAWYER]: 'Unavailable for legal reasons',
    [ErrnoCode.ESERVERERROR]: 'Internal server error',
    [ErrnoCode.EUPSTREAM]: 'Bad gateway',
    [ErrnoCode.EPROXYWAIT]: 'Gateway timeout',
    [ErrnoCode.ELOGIN]: 'Request denied',
    [ErrnoCode.EPERM]: 'Operation not permitted',
    [ErrnoCode.ENOENT]: 'No such file or directory',
    [ErrnoCode.ESRCH]: 'No such process',
    [ErrnoCode.EINTR]: 'Interrupted system call',
    [ErrnoCode.EIO]: 'Input/output error',
    [ErrnoCode.ENXIO]: 'Device not configured',
    [ErrnoCode.ENOEXEC]: 'Exec format error',
    [ErrnoCode.EBADF]: 'Bad file descriptor',
    [ErrnoCode.ECHILD]: 'No child processes',
    [ErrnoCode.EDEADLK]: 'Resource deadlock avoided',
    [ErrnoCode.ENOMEM]: 'Cannot allocate memory',
    [ErrnoCode.EACCES]: 'Permission denied',
    [ErrnoCode.EFAULT]: 'Bad address',
    [ErrnoCode.ENOTBLK]: 'Block device required',
    [ErrnoCode.EBUSY]: 'Device / Resource busy',
    [ErrnoCode.EEXIST]: 'File exists',
    [ErrnoCode.EXDEV]: 'Cross-device link',
    [ErrnoCode.ENODEV]: 'Operation not supported by device',
    [ErrnoCode.ENOTDIR]: 'Not a directory',
    [ErrnoCode.EISDIR]: 'Is a directory',
    [ErrnoCode.EINVAL]: 'Invalid argument',
    [ErrnoCode.ENFILE]: 'Too many open files in system',
    [ErrnoCode.EMFILE]: 'Too many open files',
    [ErrnoCode.ENOTTY]: 'Inappropriate ioctl for device',
    [ErrnoCode.ETXTBSY]: 'Text file busy',
    [ErrnoCode.EFBIG]: 'File too large',
    [ErrnoCode.ENOSPC]: 'No space left on device',
    [ErrnoCode.ESPIPE]: 'Illegal seek',
    [ErrnoCode.EROFS]: 'Read-only file system',
    [ErrnoCode.EMLINK]: 'Too many links',
    [ErrnoCode.EPIPE]: 'Broken pipe',
    [ErrnoCode.EDOM]: 'Numerical argument out of domain',
    [ErrnoCode.ERANGE]: 'Result too large',
    [ErrnoCode.EAGAIN]: 'Resource temporarily unavailable',
    [ErrnoCode.EINPROGRESS]: 'Operation now in progress',
    [ErrnoCode.EALREADY]: 'Operation already in progress',
    [ErrnoCode.ENOTSOCK]: 'Socket operation on non-socket',
    [ErrnoCode.EDESTADDRREQ]: 'Destination address required',
    [ErrnoCode.EMSGSIZE]: 'Message too long',
    [ErrnoCode.EPROTOTYPE]: 'Protocol wrong type for socket',
    [ErrnoCode.ENOPROTOOPT]: 'Protocol not available',
    [ErrnoCode.EPROTONOSUPPORT]: 'Protocol not supported',
    [ErrnoCode.ESOCKTNOSUPPORT]: 'Socket type not supported',
    [ErrnoCode.ENOTSUP]: 'Operation not supported',
    [ErrnoCode.EPFNOSUPPORT]: 'Protocol family not supported',
    [ErrnoCode.EAFNOSUPPORT]: 'Address family not supported by protocol family',
    [ErrnoCode.EADDRINUSE]: 'Address already in use',
    [ErrnoCode.EADDRNOTAVAIL]: "Can't assign requested address",
    [ErrnoCode.ENETDOWN]: 'Network is down',
    [ErrnoCode.ENETUNREACH]: 'Network is unreachable',
    [ErrnoCode.ENETRESET]: 'Network dropped connection on reset',
    [ErrnoCode.ECONNABORTED]: 'Software caused connection abort',
    [ErrnoCode.ECONNRESET]: 'Connection reset by peer',
    [ErrnoCode.ENOBUFS]: 'No buffer space available',
    [ErrnoCode.EISCONN]: 'Socket is already connected',
    [ErrnoCode.ENOTCONN]: 'Socket is not connected',
    [ErrnoCode.ESHUTDOWN]: "Can't send after socket shutdown",
    [ErrnoCode.ETOOMANYREFS]: "Too many references: can't splice",
    [ErrnoCode.ETIMEDOUT]: 'Operation timed out',
    [ErrnoCode.ECONNREFUSED]: 'Connection refused',
    [ErrnoCode.ELOOP]: 'Too many levels of symbolic links',
    [ErrnoCode.ENAMETOOLONG]: 'File name too long',
    [ErrnoCode.EHOSTDOWN]: 'Host is down',
    [ErrnoCode.EHOSTUNREACH]: 'No route to host',
    [ErrnoCode.ENOTEMPTY]: 'Directory not empty',
    [ErrnoCode.EPROCLIM]: 'Too many processes',
    [ErrnoCode.EUSERS]: 'Too many users',
    [ErrnoCode.EDQUOT]: 'Disc quota exceeded',
    [ErrnoCode.ESTALE]: 'Stale NFS file handle',
    [ErrnoCode.EREMOTE]: 'Too many levels of remote in path',
    [ErrnoCode.EBADRPC]: 'RPC struct is bad',
    [ErrnoCode.ERPCMISMATCH]: 'RPC version wrong',
    [ErrnoCode.EPROGUNAVAIL]: 'RPC prog. not avail',
    [ErrnoCode.EPROGMISMATCH]: 'Program version wrong',
    [ErrnoCode.EPROCUNAVAIL]: 'Bad procedure for program',
    [ErrnoCode.ENOLCK]: 'No locks available',
    [ErrnoCode.ENOSYS]: 'Function not implemented',
    [ErrnoCode.EFTYPE]: 'Inappropriate file type or format',
    [ErrnoCode.EAUTH]: 'Authentication error',
    [ErrnoCode.ENEEDAUTH]: 'Need authenticator',
    [ErrnoCode.EPWROFF]: 'Device power is off',
    [ErrnoCode.EDEVERR]: 'Device error, e.g. paper out',
    [ErrnoCode.EOVERFLOW]: 'Value too large to be stored in data type',
    [ErrnoCode.EBADEXEC]: 'Bad executable',
    [ErrnoCode.EBADARCH]: 'Bad CPU type in executable',
    [ErrnoCode.ESHLIBVERS]: 'Shared library version mismatch',
    [ErrnoCode.EBADMACHO]: 'Malformed Macho file',
    [ErrnoCode.ECANCELED]: 'Operation canceled',
    [ErrnoCode.EIDRM]: 'Identifier removed',
    [ErrnoCode.ENOMSG]: 'No message of desired type',
    [ErrnoCode.EILSEQ]: 'Illegal byte sequence',
    [ErrnoCode.ENOATTR]: 'Attribute not found',
    [ErrnoCode.EBADMSG]: 'Bad message',
    [ErrnoCode.EMULTIHOP]: 'Reserved',
    [ErrnoCode.ENODATA]: 'No message available on STREAM',
    [ErrnoCode.ENOLINK]: 'Reserved',
    [ErrnoCode.ENOSR]: 'No STREAM resources',
    [ErrnoCode.ENOSTR]: 'Not a STREAM',
    [ErrnoCode.EPROTO]: 'Protocol error',
    [ErrnoCode.ETIME]: 'STREAM ioctl timeout',
    [ErrnoCode.EOPNOTSUPP]: 'Operation not supported on socket',
    [ErrnoCode.ENOPOLICY]: 'No such policy registered',
    [ErrnoCode.ENOTRECOVERABLE]: 'State not recoverable',
    [ErrnoCode.EOWNERDEAD]: 'Previous owner died',
    [ErrnoCode.EQFULL]: 'Interface output queue is full',
    [ErrnoCode.ENOTCAPABLE]: 'Capabilities insufficient',
};
