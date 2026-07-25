import { cn } from "@/utils/styles/utils"

export function ConfigCard({
  id,
  title,
  description,
  children,
  className,
  titleClassName,
  layout = "responsive",
}: {
  id?: string
  title: React.ReactNode
  description: React.ReactNode
  children: React.ReactNode
  className?: string
  titleClassName?: string
  layout?: "responsive" | "stacked"
}) {
  return (
    <section
      id={id}
      className={cn(
        "flex flex-col gap-y-6 py-6",
        layout === "responsive" && "lg:flex-row lg:gap-x-[50px] xl:gap-x-[100px]",
        className,
      )}
    >
      <div className={cn("shrink-0", layout === "responsive" && "lg:basis-2/5")}>
        <h2 className={cn("mb-1 text-lg font-bold", titleClassName)}>{title}</h2>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      <div className={cn("min-w-0", layout === "responsive" && "lg:basis-3/5")}>{children}</div>
    </section>
  )
}
