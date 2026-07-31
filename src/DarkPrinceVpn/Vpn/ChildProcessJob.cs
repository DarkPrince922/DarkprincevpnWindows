using System.Diagnostics;
using System.Runtime.InteropServices;

namespace DarkPrinceVpn.Vpn;

/// <summary>
/// Объект задания Windows, к которому привязываются ядро и мост. Пока
/// приложение живо, дескриптор задания открыт; как только процесс исчезает —
/// хоть штатно, хоть снятый через диспетчер задач, хоть упавший — система
/// сама убивает всех потомков.
///
/// Без этого <c>xray.exe</c> и <c>tun2socks.exe</c> оставались бы висеть
/// в диспетчере и держать туннель после закрытия окна.
/// </summary>
public static class ChildProcessJob
{
    private static readonly IntPtr Handle = Create();

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    private const uint LimitKillOnJobClose = 0x2000;
    private const int ExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll")]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    private static IntPtr Create()
    {
        try
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;

            var info = new JobObjectExtendedLimitInformation
            {
                BasicLimitInformation = { LimitFlags = LimitKillOnJobClose },
            };
            var size = Marshal.SizeOf(info);
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, pointer, false);
                SetInformationJobObject(job, ExtendedLimitInformation, pointer, (uint)size);
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
            return job;
        }
        catch (Exception)
        {
            return IntPtr.Zero;
        }
    }

    public static void Attach(Process process)
    {
        if (Handle == IntPtr.Zero) return;
        try
        {
            AssignProcessToJobObject(Handle, process.Handle);
        }
        catch (Exception)
        {
            // не критично: процесс всё равно останавливается штатно
        }
    }
}
