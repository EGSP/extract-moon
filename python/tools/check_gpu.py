"""Проверка, что torch видит GTX 1050 и реально считает на ней (а не только «доступна»)."""

import sys
import time

import torch


def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    print(f"torch {torch.__version__}, CUDA сборки {torch.version.cuda}")
    if not torch.cuda.is_available():
        print("CUDA недоступна — обучение пойдёт на CPU")
        return
    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    free, total = torch.cuda.mem_get_info()
    print(f"GPU: {name}, sm_{cap[0]}{cap[1]}, память свободно {free / 2**20:.0f} из {total / 2**20:.0f} МБ")
    print(f"архитектуры в сборке: {torch.cuda.get_arch_list()}")

    a = torch.randn(2048, 2048, device="cuda")
    b = torch.randn(2048, 2048, device="cuda")
    ref = (a.cpu() @ b.cpu())
    torch.cuda.synchronize()
    t0 = time.time()
    for _ in range(20):
        c = a @ b
    torch.cuda.synchronize()
    dt = (time.time() - t0) / 20
    err = (c.cpu() - ref).abs().max().item()
    print(f"matmul 2048x2048: {2 * 2048**3 / dt / 1e12:.2f} TFLOPS, расхождение с CPU {err:.2e}")
    conv = torch.nn.Conv2d(7, 32, 3, padding=1).cuda()
    conv(torch.randn(64, 7, 11, 11, device="cuda")).sum().backward()
    torch.cuda.synchronize()
    print("свёртка и backward на GPU: OK")


if __name__ == "__main__":
    main()
