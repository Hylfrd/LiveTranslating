$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LiveTranslating {
  public enum EDataFlow { Render, Capture, All }
  public enum ERole { Console, Multimedia, Communications }
  public enum AudioSessionState { Inactive, Active, Expired }

  [Flags]
  public enum DeviceState : uint {
    Active = 0x00000001
  }

  [ComImport]
  [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  public class MMDeviceEnumeratorComObject { }

  [ComImport]
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, DeviceState stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
  }

  [ComImport]
  [Guid("0BD7A1BE-7A1A-44DB-8397-C0A7B8A53A10")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }

  [ComImport]
  [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint classContext, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, IntPtr properties);
    [PreserveSig] int GetId(out IntPtr id);
    [PreserveSig] int GetState(out DeviceState state);
  }

  [ComImport]
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(ref Guid sessionGuid, uint streamFlags, out IntPtr sessionControl);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid sessionGuid, uint streamFlags, out IntPtr audioVolume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
    [PreserveSig] int RegisterSessionNotification(IntPtr sessionNotification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr sessionNotification);
    [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr duckNotification);
  }

  [ComImport]
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl session);
  }

  [ComImport]
  [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl {
    [PreserveSig] int GetState(out AudioSessionState state);
    [PreserveSig] int GetDisplayName(out IntPtr displayName);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
    [PreserveSig] int GetIconPath(out IntPtr iconPath);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid groupingId);
    [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  }

  [ComImport]
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out AudioSessionState state);
    [PreserveSig] int GetDisplayName(out IntPtr displayName);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
    [PreserveSig] int GetIconPath(out IntPtr iconPath);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
    [PreserveSig] int GetGroupingParam(out Guid groupingId);
    [PreserveSig] int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    [PreserveSig] int GetSessionIdentifier(out IntPtr sessionIdentifier);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr sessionInstanceIdentifier);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }

  public sealed class AudioSessionRecord {
    public uint processId { get; set; }
    public int state { get; set; }
    public string displayName { get; set; }
    public string processName { get; set; }
    public string executablePath { get; set; }
    public string fileDescription { get; set; }
    public string windowTitle { get; set; }
  }

  public static class AudioSessionProbe {
    private const uint CLSCTX_ALL = 23;

    public static List<AudioSessionRecord> Enumerate() {
      var records = new List<AudioSessionRecord>();
      IMMDeviceEnumerator enumerator = null;
      IMMDevice device = null;
      try {
        enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, ERole.Multimedia, out device));
        var managerGuid = typeof(IAudioSessionManager2).GUID;
        object managerObject;
        Marshal.ThrowExceptionForHR(device.Activate(ref managerGuid, CLSCTX_ALL, IntPtr.Zero, out managerObject));
        var manager = (IAudioSessionManager2)managerObject;
        try {
          IAudioSessionEnumerator sessions;
          Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
          try {
            int sessionCount;
            Marshal.ThrowExceptionForHR(sessions.GetCount(out sessionCount));
            for (int sessionIndex = 0; sessionIndex < sessionCount; sessionIndex++) {
              IAudioSessionControl control = null;
              try {
                if (sessions.GetSession(sessionIndex, out control) != 0 || control == null) continue;
                var control2 = (IAudioSessionControl2)control;
                AudioSessionState state;
                uint processId;
                if (control2.GetState(out state) != 0 || control2.GetProcessId(out processId) != 0 || processId == 0) continue;
                IntPtr displayNamePointer;
                var displayName = "";
                if (control2.GetDisplayName(out displayNamePointer) == 0 && displayNamePointer != IntPtr.Zero) {
                  try { displayName = Marshal.PtrToStringUni(displayNamePointer) ?? ""; }
                  finally { Marshal.FreeCoTaskMem(displayNamePointer); }
                }
                records.Add(DescribeProcess(processId, state, displayName));
              } catch { }
              finally { Release(control); }
            }
          } finally { Release(sessions); }
        } finally { Release(manager); }
      } finally {
        Release(device);
        Release(enumerator);
      }
      return records;
    }

    private static AudioSessionRecord DescribeProcess(uint processId, AudioSessionState state, string displayName) {
      var record = new AudioSessionRecord {
        processId = processId,
        state = (int)state,
        displayName = displayName ?? "",
        processName = "",
        executablePath = "",
        fileDescription = "",
        windowTitle = ""
      };
      try {
        using (var process = Process.GetProcessById((int)processId)) {
          record.processName = process.ProcessName ?? "";
          record.windowTitle = process.MainWindowTitle ?? "";
          try {
            var module = process.MainModule;
            if (module != null) {
              record.executablePath = module.FileName ?? "";
              if (module.FileVersionInfo != null) record.fileDescription = module.FileVersionInfo.FileDescription ?? "";
            }
          } catch { }
        }
      } catch { }
      return record;
    }

    private static void Release(object value) {
      if (value != null && Marshal.IsComObject(value)) {
        try { Marshal.ReleaseComObject(value); } catch { }
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
@([LiveTranslating.AudioSessionProbe]::Enumerate()) | ConvertTo-Json -Compress
