param([Parameter(Mandatory = $true)][string]$Payload)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PrimeContinuimJobRunner {
 const uint CREATE_SUSPENDED=4, EXTENDED_STARTUPINFO_PRESENT=0x80000, STARTF_USESTDHANDLES=0x100, KILL_ON_CLOSE=0x2000, INFINITE=0xffffffff, WAIT_OBJECT_0=0;
 const int ExtendedLimits=9, BasicAccounting=1;
 static readonly UIntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST=(UIntPtr)0x0002000D;
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string a,b,c; public uint x,y,xs,ys,xc,yc,fill,flags; public short show,reserved; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
 [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process,thread; public uint processId,threadId; }
 [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS { public BASIC_LIMITS basic; public IO_COUNTERS io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint faults,total,active,terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr i,uint l,out uint r);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr p,out uint e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr p,uint e);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr GetStdHandle(int n);
 static void Check(bool ok,string operation) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error(),operation); }
 static Exception First(Exception current,Exception next) { return current??next; }
 public static int Run(string executable,string commandLine,string cwd) {
  IntPtr job=IntPtr.Zero,process=IntPtr.Zero,thread=IntPtr.Zero,attributes=IntPtr.Zero,jobValue=IntPtr.Zero; bool resumed=false;
  try {
   job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"CreateJobObject failed");
   var limits=new EXTENDED_LIMITS(); limits.basic.flags=KILL_ON_CLOSE; int ls=Marshal.SizeOf(typeof(EXTENDED_LIMITS)); IntPtr lp=Marshal.AllocHGlobal(ls);
   try { Marshal.StructureToPtr(limits,lp,false); Check(SetInformationJobObject(job,ExtendedLimits,lp,(uint)ls),"SetInformationJobObject failed"); } finally { Marshal.FreeHGlobal(lp); }
   IntPtr attributeSize=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref attributeSize); if(attributeSize==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error(),"Attribute-list sizing failed");
   attributes=Marshal.AllocHGlobal(attributeSize); Check(InitializeProcThreadAttributeList(attributes,1,0,ref attributeSize),"Attribute-list initialization failed");
   jobValue=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue,job); Check(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,jobValue,(UIntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"Job-list attribute publication failed");
   var si=new STARTUPINFOEX(); si.startup.cb=Marshal.SizeOf(typeof(STARTUPINFOEX)); si.startup.flags=STARTF_USESTDHANDLES; si.startup.input=GetStdHandle(-10); si.startup.output=GetStdHandle(-11); si.startup.error=GetStdHandle(-12); si.attributes=attributes;
   PROCESS_INFORMATION pi; Check(CreateProcess(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|EXTENDED_STARTUPINFO_PRESENT,IntPtr.Zero,cwd,ref si,out pi),"CreateProcess failed"); process=pi.process; thread=pi.thread;
   if(ResumeThread(thread)==0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(),"ResumeThread failed"); resumed=true;
    Check(WaitForSingleObject(process,INFINITE)==WAIT_OBJECT_0,"Process wait failed"); uint exitCode; Check(GetExitCodeProcess(process,out exitCode),"GetExitCodeProcess failed");
    Check(TerminateJobObject(job,exitCode),"TerminateJobObject failed"); int size=Marshal.SizeOf(typeof(ACCOUNTING)); IntPtr ap=Marshal.AllocHGlobal(size);
     try { for(int n=0;n<100;n++){ uint returned; Check(QueryInformationJobObject(job,BasicAccounting,ap,(uint)size,out returned),"QueryInformationJobObject failed"); var a=(ACCOUNTING)Marshal.PtrToStructure(ap,typeof(ACCOUNTING)); if(a.active==0)return unchecked((int)exitCode); Thread.Sleep(50); } throw new TimeoutException("Windows job descendants did not terminate within 5 seconds."); }
    finally { Marshal.FreeHGlobal(ap); }
  } finally { Exception cleanup=null; if(process!=IntPtr.Zero&&!resumed&&!TerminateProcess(process,1))cleanup=First(cleanup,new Win32Exception(Marshal.GetLastWin32Error(),"TerminateProcess failed during suspended-child cleanup")); if(thread!=IntPtr.Zero&&!CloseHandle(thread))cleanup=First(cleanup,new Win32Exception(Marshal.GetLastWin32Error(),"Thread-handle close failed")); if(job!=IntPtr.Zero&&!CloseHandle(job))cleanup=First(cleanup,new Win32Exception(Marshal.GetLastWin32Error(),"Job-handle close failed")); if(process!=IntPtr.Zero&&!resumed&&WaitForSingleObject(process,5000)!=WAIT_OBJECT_0)cleanup=First(cleanup,new TimeoutException("Suspended in-job child termination was not confirmed.")); if(process!=IntPtr.Zero&&!CloseHandle(process))cleanup=First(cleanup,new Win32Exception(Marshal.GetLastWin32Error(),"Process-handle close failed")); if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);} if(jobValue!=IntPtr.Zero)Marshal.FreeHGlobal(jobValue); if(cleanup!=null)throw cleanup; }
  }
}
'@
try {
 $configuration=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
 $code=[PrimeContinuimJobRunner]::Run([string]$configuration.executable,[string]$configuration.commandLine,[string]$configuration.cwd)
 [Environment]::Exit($code)
} catch { [Console]::Error.WriteLine("Prime Continuim Windows job supervisor failed: $($_.Exception.Message)"); [Environment]::Exit(1) }
