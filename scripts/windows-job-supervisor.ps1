param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PrimeContinuimJobRunner {
 const uint CREATE_SUSPENDED=4, STARTF_USESTDHANDLES=0x100, KILL_ON_CLOSE=0x2000, INFINITE=0xffffffff;
 const int ExtendedLimits=9, BasicAccounting=1;
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string a,b,c; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr i,uint l,out uint r);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int n);
 static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
 public static int Run(string executable,string commandLine,string cwd) {
  IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero;
  try {
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject failed");
   var limits=new EXTENDED_LIMITS(); limits.basic.flags=KILL_ON_CLOSE; int ls=Marshal.SizeOf(typeof(EXTENDED_LIMITS)); IntPtr lp=Marshal.AllocHGlobal(ls);
   try { Marshal.StructureToPtr(limits,lp,false); Check(SetInformationJobObject(job,ExtendedLimits,lp,(uint)ls),"SetInformationJobObject failed"); } finally { Marshal.FreeHGlobal(lp); }
   var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(typeof(STARTUPINFO)); si.flags=STARTF_USESTDHANDLES; si.input=GetStdHandle(-10); si.output=GetStdHandle(-11); si.error=GetStdHandle(-12);
   PROCESS_INFORMATION pi; Check(CreateProcess(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED,IntPtr.Zero,cwd,ref si,out pi),"CreateProcess failed"); process=pi.process; thread=pi.thread;
   Check(AssignProcessToJobObject(job,process),"AssignProcessToJobObject failed"); if(ResumeThread(thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread failed");
   WaitForSingleObject(process,INFINITE); uint exitCode; Check(GetExitCodeProcess(process,out exitCode),"GetExitCodeProcess failed");
   TerminateJobObject(job,exitCode); int size=Marshal.SizeOf(typeof(ACCOUNTING)); IntPtr ap=Marshal.AllocHGlobal(size);
   try { for(int n=0;n<100;n++){ uint returned; Check(QueryInformationJobObject(job,BasicAccounting,ap,(uint)size,out returned),"QueryInformationJobObject failed"); var a=(ACCOUNTING)Marshal.PtrToStructure(ap,typeof(ACCOUNTING)); if(a.active==0)return unchecked((int)exitCode); Thread.Sleep(50); } throw new TimeoutException("Windows job descendants did not terminate within 5 seconds."); }
   finally { Marshal.FreeHGlobal(ap); }
  } finally { if(thread!=IntPtr.Zero)CloseHandle(thread); if(process!=IntPtr.Zero)CloseHandle(process); if(job!=IntPtr.Zero)CloseHandle(job); }
 }
}
'@
try {
 $configuration=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
 $code=[PrimeContinuimJobRunner]::Run([string]$configuration.executable,[string]$configuration.commandLine,[string]$configuration.cwd)
 [Environment]::Exit($code)
} catch { [Console]::Error.WriteLine("Prime Continuim Windows job supervisor failed: $($_.Exception.Message)"); [Environment]::Exit(1) }
